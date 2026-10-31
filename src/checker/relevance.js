// Relevance layer for the Price Checker's database search, in three steps:
//
//   1. understandQuery() — work out what the typed words ARE: model codes,
//      spec figures (750g, 128GB), bare model numbers ("5" in PlayStation 5)
//      and plain words. Every plain word is weighted by how rare it is across
//      the whole competitor_products catalogue (inverse document frequency):
//      "nutella" or "issey" pin the product down, "jar"/"chocolate"/"watch"
//      barely narrow anything. A word the catalogue mostly spells differently
//      ("parfume" vs perfume/parfum, "marshmellow" vs marshmallow) is flagged
//      as a spelling variant and later matched within a small edit distance.
//
//   2. fanOutQueries() — several narrow "grep" (LIKE) searches instead of one:
//      each model code alone, the rarest words alone and in pairs, with a
//      vowel-wildcard pattern for misspelled words. A listing that omits the
//      brand, or that the query misspells, is still reached by some branch.
//
//   3. relevanceMatch() — scores every retrieved listing from BOTH sides:
//      how much of the query's weight the listing carries (query coverage)
//      and how much of the listing's own weight the query accounts for
//      (listing coverage). "Nutella Chocolate Spread 750g" lacks two of the
//      query's words ("Ferrero", "Jar") but everything it says is in the
//      query and its 750g agrees, so it matches; "ESR Classic Geo Wallet"
//      shares two words with "Classic Handbag With Wallet" but not the rare
//      one ("handbag"), so it doesn't. The usual hard vetoes (spec conflict,
//      accessory, product-line qualifier, different model number, different
//      SKU) still apply first.

import { tokenSequence, searchPrefixes, normalizeName, SPEC_TOKEN, codesMatch } from '../compare/normalize.js';
import { accessoryMismatch, qualifierMismatch, leadsWithQuery, ACCESSORY_WORDS } from '../compare/audit-scoring.js';
import { countCompetitorProductsMatching } from '../db.js';

const FREQ_TTL_MS = 12 * 60 * 60 * 1000;
const freqCache = new Map(); // LIKE pattern -> { at, promise }
const MAX_PARALLEL_COUNTS = 12;

function countMatching(pattern) {
  const now = Date.now();
  const hit = freqCache.get(pattern);
  if (hit && now - hit.at < FREQ_TTL_MS) return hit.promise;
  const promise = countCompetitorProductsMatching(pattern);
  freqCache.set(pattern, { at: now, promise });
  promise.catch(() => freqCache.delete(pattern));
  return promise;
}

// Words of <=4 letters are counted at a word start ("% ala%"), otherwise a
// plain substring count wildly overstates them ("ala" inside "salad").
function likePattern(sql) {
  return sql.length <= 4 ? `% ${sql}%` : `%${sql}%`;
}

// "marshmellow" -> "m_rshm_ll_w": a LIKE pattern that also matches the other
// common spelling(s) of the word. The first letter is kept as-is.
function vowelWildcard(word) {
  return word[0] + word.slice(1).replace(/[aeiouy]/g, '_');
}

const UNIT_WORD = /^(inch|cm|mm|kg|ml|gb|tb|mb|g|l|w|v|mah|ltr|litre|liter)$/;

// Spec numbers (the 750 in 750g) are judged by the spec veto/agreement in
// relevanceMatch, not as words — a listing that omits its size isn't missing
// a word, it's just terser.
function specNumbers(specs) {
  const out = new Set();
  for (const vals of Object.values(specs)) for (const v of vals) out.add(String(v));
  return out;
}

/**
 * @param {object} indexed  the query as indexed by compare/matcher.js index()
 * @returns {Promise<{indexed, words, numbers, codes, total}>}
 *   words: [{ token, sql, weight, fuzzy, pattern }] plain words, rarest first
 */
export async function understandQuery(indexed) {
  const specNums = specNumbers(indexed._specs);
  const words = [];
  const numbers = new Set();
  const seen = new Set();
  for (const raw of normalizeName(indexed.name).split(' ')) {
    const sql = searchPrefixes(raw)[0];
    for (const token of tokenSequence(raw)) {
      if (seen.has(token)) continue;
      seen.add(token);
      if (indexed._codes.has(token)) continue;
      if (UNIT_WORD.test(token) || SPEC_TOKEN.test(token) || specNums.has(token)) continue;
      if (/\d/.test(token)) {
        numbers.add(token);
        continue;
      }
      if (sql) words.push({ token, sql });
    }
  }

  // Catalogue frequencies. A failure here (no count support, network) leaves
  // every word equally weighted rather than failing the search.
  let total = 0;
  try {
    const jobs = [() => countMatching('%').then((n) => { total = n; })];
    for (const w of words) {
      jobs.push(() => countMatching(likePattern(w.sql)).then((n) => { w.df = n; }));
      if (w.sql.length >= 5 && /[aeiouy]/.test(w.sql.slice(1))) {
        w.pattern = vowelWildcard(w.sql);
        jobs.push(() => countMatching(`%${w.pattern}%`).then((n) => { w.familyDf = n; }));
      }
    }
    for (let i = 0; i < jobs.length; i += MAX_PARALLEL_COUNTS) {
      await Promise.all(jobs.slice(i, i + MAX_PARALLEL_COUNTS).map((j) => j()));
    }
  } catch (err) {
    console.warn('! word-frequency lookup failed, weighting words equally:', err.message);
    total = 0;
  }

  for (const w of words) {
    if (!total) {
      w.weight = 1;
      continue;
    }
    const df = w.df ?? 0;
    const family = w.familyDf ?? 0;
    // The catalogue overwhelmingly writes this word another way
    // ("marshmellow" 8 vs its vowel family 150, "parfume" vs perfume): treat
    // it as that family. Only for longer words — a short word's vowel
    // pattern ("h_n__" for honey) matches thousands of unrelated words.
    w.fuzzy = w.sql.length >= 7 && Boolean(w.pattern) && family >= 10 * Math.max(df, 1);
    const effective = w.fuzzy ? family : df;
    // A word no listing contains in any spelling can't tell listings apart
    // (Kapruka-only wording) — leave it out of the weighting instead of
    // letting it sink every match. A word only a handful of listings use is
    // either a small brand ("Gima", 3 listings) or a typo ("Coner" for
    // Corner, also 3): both keep their weight, and `rare` lets it match one
    // letter off from 5 letters up (see wordSpellsLike), which catches the
    // typo without loosening anything for ordinary words.
    w.rare = df < RARE_DF;
    w.weight = effective === 0 ? 0 : Math.max(0.5, Math.log((total + 1) / (effective + 1)));
  }
  words.sort((a, b) => b.weight - a.weight);
  return { indexed, words, numbers, codes: indexed._codes, total, phrases: numberPhrases(indexed.name, numbers) };
}

const RARE_DF = 5;

// "iphone 18", "18 pro", "playstation 5": a bare model number next to a word,
// grepped as one phrase. On their own, "iphone" or "playstation" match
// thousands of listings (games, cases) and the LIKE search's row cap cuts
// off the actual product; the phrase pins it down.
function numberPhrases(name, numbers) {
  const parts = normalizeName(name).split(' ');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i++) {
    const [a, b] = [parts[i], parts[i + 1]];
    const num = numbers.has(a) ? b : numbers.has(b) ? a : null;
    if (!num || /\d/.test(num) || num.length < 2 || UNIT_WORD.test(num)) continue;
    out.push(`${a} ${b}`);
  }
  return out.slice(0, 3);
}

const FAN_OUT_SINGLE_MAX = 500; // a single word broader than this would be cut off arbitrarily

/** The LIKE searches to run, each an AND-ed list of substrings. */
export function fanOutQueries(u) {
  const sqlOf = (w) => (w.fuzzy ? w.pattern : w.sql);
  const anchors = u.words.filter((w) => w.weight > 0).slice(0, 3);
  const queries = [];
  const add = (q) => {
    const key = q.join('&');
    if (q.length && !queries.some((x) => x.join('&') === key)) queries.push(q);
  };
  for (const c of [...u.codes].slice(0, 2)) add([c]);
  for (const p of u.phrases) add([p]);
  for (const w of anchors.slice(0, 2)) {
    const df = w.fuzzy ? w.familyDf : w.df;
    if (df == null || df <= FAN_OUT_SINGLE_MAX) add([sqlOf(w)]);
  }
  const [a, b, c] = anchors;
  if (a && b) add([sqlOf(a), sqlOf(b)]);
  if (b && c) add([sqlOf(b), sqlOf(c)]);
  if (a && c) add([sqlOf(a), sqlOf(c)]);
  if (anchors.length === 1) add([sqlOf(anchors[0])]);
  // A word almost no listing spells this way is most likely a typo of one
  // many listings do ("sunscren"): grep two short fragments of it instead,
  // one pair from each end, and let hasWord()'s edit-distance check decide.
  for (const w of anchors.slice(0, 2)) {
    if (!w.rare || w.fuzzy || w.sql.length < 6) continue;
    const s = w.sql;
    add([s.slice(0, 3), s.slice(3, 6)]);
    add([s.slice(-6, -3), s.slice(-3)]);
  }
  return queries;
}

// Bounded Levenshtein distance (returns max+1 as soon as it's exceeded).
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Exact token, a near-spelling (one typo in a 6+ letter word, two in 9+),
// or the retailer's own domain: shops don't repeat their own brand in their
// titles ("Baby Tape Diapers ..." on kimrox.lk is a Kimrox product).
function spellsLike(a, b, minLen = 6) {
  if (a === b) return true;
  if (a.length < minLen || a[0] !== b[0] || /\d/.test(b)) return false;
  const max = a.length >= 9 ? 2 : 1;
  return editDistance(a, b, max) <= max;
}
function wordSpellsLike(w, t) {
  return spellsLike(w.token, t, w.rare ? 5 : 6);
}
function hasWord(w, c) {
  if (c._tokens.has(w.token)) return true;
  if (w.token.length >= 4 && c.siteDomain && c.siteDomain.split('.')[0].includes(w.token)) return true;
  for (const t of c._tokens) if (wordSpellsLike(w, t)) return true;
  return false;
}

// The query's distinctive word is missing AND the listing has a different
// word in that same slot: a different brand ("Kimrox" -> "Marvel Baby ...
// Diapers", "Sokany" -> "Sonifer ... Stand Mixer") or a different model of
// the same brand ("JBL Rise" -> "JBL Horizon 2"). A word that's merely
// omitted ("Sony" in "PlayStation 5 Slim Console") leaves the slot to the
// next query word, so it isn't caught here.
function substitutedWord(u, c, present) {
  const scored = u.words.filter((w) => w.weight > 0);
  if (!scored.length) return null;
  const bar = 0.5 * scored[0].weight;
  const qSeq = tokenSequence(u.indexed.name);
  const cSeq = tokenSequence(c.name);
  for (const w of scored) {
    if (w.weight < bar || present.has(w.token)) continue;
    const i = qSeq.indexOf(w.token);
    let at = -1;
    for (let j = i - 1; j >= 0; j--) {
      const k = cSeq.indexOf(qSeq[j]);
      if (k !== -1) { at = k; break; }
    }
    const slot = cSeq[at + 1];
    if (!slot || /\d/.test(slot) || UNIT_WORD.test(slot)) continue;
    if (u.indexed._tokens.has(slot) || scored.some((x) => wordSpellsLike(x, slot))) continue;
    return { missing: w.token, instead: slot };
  }
  return null;
}

function specsAgree(a, b) {
  for (const unit of Object.keys(a)) {
    if (!b[unit]) continue;
    for (const v of a[unit]) if (b[unit].has(v)) return true;
  }
  return false;
}
function specsConflictAny(a, b) {
  for (const unit of Object.keys(a)) {
    if (!b[unit]) continue;
    if (![...a[unit]].some((v) => b[unit].has(v))) return true;
  }
  return false;
}

// Weight for a listing word the query doesn't contain — for listing coverage.
function listingWordWeight(t, u) {
  if (/\d/.test(t) || UNIT_WORD.test(t)) return 0;
  const known = u.words.find((w) => w.token === t);
  if (known) return known.weight;
  // Unknown frequency: an average catalogue word.
  return u.total ? 4 : 1;
}

export const RELEVANCE_BROAD_MAX_RATE = 75;

function presentWords(u, c) {
  const present = new Set();
  for (const w of u.words) if (w.weight > 0 && hasWord(w, c)) present.add(w.token);
  return present;
}

// Do the two sides name the same SKU? 'none' when either side names none.
function codeAgreement(u, c) {
  if (!u.codes.size || !c._codes.size) return 'none';
  return [...u.codes].some((a) => [...c._codes].some((b) => codesMatch(a, b))) ? 'shared' : 'differ';
}

/**
 * Hard "this is a different product" verdicts that also override the audit
 * system's scoreCandidate() acceptance in db-search.js — its one-word waiver
 * can't tell a brand that's omitted from one that's been replaced.
 */
export function relevanceVeto(u, c) {
  if (madeForQueryProduct(u, c) || misspeltAccessory(u, c) || genderMismatch(u, c)) return true;
  if (u.codes.size && [...u.codes].every((a) => [...c._codes].some((b) => codesMatch(a, b)))) return false;
  const present = presentWords(u, c);
  return Boolean(substitutedWord(u, c, present)) || missingTopWord(u, present);
}

// "Eternity Air For Men" vs "... For Women": the men's and women's versions
// of a fragrance or garment are different products at different prices.
const GENDER = [
  [['men', 'man', 'him', 'his', 'male', 'boy', 'gent', 'homme'], ['women', 'woman', 'her', 'female', 'girl', 'lady', 'ladie', 'femme']],
];
function genderMismatch(u, c) {
  for (const [a, b] of GENDER) {
    const qa = a.some((t) => u.indexed._tokens.has(t));
    const qb = b.some((t) => u.indexed._tokens.has(t));
    const ca = a.some((t) => c._tokens.has(t));
    const cb = b.some((t) => c._tokens.has(t));
    if ((qa && !qb && cb && !ca) || (qb && !qa && ca && !cb)) return true;
  }
  return false;
}

// The query's most distinctive word is absent, and nothing that IS present
// is nearly as specific. Leaving out "Sony" is fine when "PlayStation" is
// there to identify the product; leaving out "Capilano" leaves "Pure Honey",
// which every honey brand's listing says.
function missingTopWord(u, present) {
  const scored = u.words.filter((w) => w.weight > 0);
  if (!scored.length || present.has(scored[0].token)) return false;
  return !scored.some((w) => present.has(w.token) && w.weight >= 0.9 * scored[0].weight);
}

// "Dobe Cooling Fan For PlayStation 5 Pro", "Screen Protector for iPhone 18
// Pro": the query's product appears only as what the listing is FOR. Not
// applied when the query itself says "for" ("Shampoo For Men").
const FOR_WORDS = new Set(['for', 'fits', 'compatible']);
function madeForQueryProduct(u, c) {
  if (normalizeName(u.indexed.name).split(' ').some((w) => FOR_WORDS.has(w))) return false;
  const words = normalizeName(c.name).split(' ');
  for (let i = 0; i < words.length; i++) {
    const t = tokenSequence(words[i])[0];
    if (!t || !u.indexed._tokens.has(t)) continue;
    return i > 0 && FOR_WORDS.has(words[i - 1]);
  }
  return false;
}

// The accessory veto matches words exactly, so a shop's typo ("Screen
// Protecter") slipped past it. Plus a few companion products that only count
// as accessories next to a device named by model number or SKU ("PS5 Pro
// Travel Bag", "Cooling Fan ... PlayStation 5") — kept out of the shared
// ACCESSORY_WORDS list, where "Steam Iron with Storage Bag" is the product.
const DEVICE_COMPANION_WORDS = new Set(['bag', 'backpack', 'cooling', 'fan']);
function misspeltAccessory(u, c) {
  for (const t of u.indexed._tokens) if (ACCESSORY_WORDS.has(t) || DEVICE_COMPANION_WORDS.has(t)) return false;
  const device = u.numbers.size > 0 || u.codes.size > 0;
  for (const t of c._tokens) {
    if (u.indexed._tokens.has(t) || ACCESSORY_WORDS.has(t)) continue;
    if (device && DEVICE_COMPANION_WORDS.has(t)) return true;
    for (const a of ACCESSORY_WORDS) if (a.length >= 6 && spellsLike(a, t)) return true;
  }
  return false;
}

// How many independent identity signals the query carries: plain words the
// catalogue knows, bare model numbers, SKUs and sizes.
function identitySignals(u) {
  return u.words.filter((w) => w.weight > 0).length + u.numbers.size + u.codes.size + Object.keys(u.indexed._specs).length;
}

/**
 * A query too thin to name one product: a lone category or brand word
 * ("sunscreen", "cetaphil", "helmet"), or nothing the catalogue knows at all.
 * Such a query is never price-compared (that would line up a LKR 1,950 lotion
 * against a LKR 9,800 gel); db-search.js lists the listings that carry the
 * word instead, see categoryMatch().
 */
export function isBroadQuery(u) {
  // A SKU ("ps5", "55a61h") names a product on its own.
  return identitySignals(u) < 2 && u.codes.size === 0;
}

/**
 * For a broad query: does this listing simply carry the query's word? Returns
 * null or { kind: 'category', rate: null, value }. Deliberately NOT a match
 * claim — there is no rate, and these rows never feed the price insight.
 */
export function categoryMatch(u, c) {
  const scored = u.words.filter((w) => w.weight > 0);
  if (scored.length !== 1 || u.numbers.size || u.codes.size) return null;
  const q = u.indexed;
  if (!hasWord(scored[0], c)) return null;
  // Same exclusions as a real match: "Sunscreen Pouch", a case "for iPhone".
  if (accessoryMismatch(q._tokens, c._tokens) || madeForQueryProduct(u, c) || misspeltAccessory(u, c)) return null;
  return { kind: 'category', rate: null, value: c._tokens.size ? 1 / c._tokens.size : 0 };
}

/**
 * Null (not the same product) or { kind: 'strict'|'broad', rate, value }.
 */
export function relevanceMatch(u, c) {
  const q = u.indexed;
  const scored = u.words.filter((w) => w.weight > 0);
  // One plain word ("helmet") can't identify a product: it needs a second
  // word, a model number, a SKU or a size to go with it.
  if (identitySignals(u) < 2) return null;
  if (specsConflictAny(q._specs, c._specs)) return null;
  if (accessoryMismatch(q._tokens, c._tokens)) return null;
  if (qualifierMismatch(q._tokens, c._tokens)) return null;
  // A bare model number ("5", "15") is identity: never optional.
  for (const n of u.numbers) if (!c._tokens.has(n)) return null;

  const codes = codeAgreement(u, c);
  if (codes === 'differ') return null; // both name a SKU and they differ
  const sharedCode = codes === 'shared';

  // A SKU the query names counts as its heaviest word: a listing without it
  // ("JBL Tune Flex" for "JBL Tune 780NC") is missing the very thing that
  // identifies the product, however many of the other words it has.
  const codeWeight = u.codes.size ? Math.max(6, scored[0]?.weight || 0) : 0;
  const qTotal = scored.reduce((s, w) => s + w.weight, 0) + codeWeight;
  if (!qTotal) return null;
  const present = presentWords(u, c);
  let qHit = sharedCode ? codeWeight : 0;
  for (const w of scored) if (present.has(w.token)) qHit += w.weight;
  const qCov = qHit / qTotal;

  // Listing coverage: the listing's own words, and how many of them the
  // query accounts for (near-spellings included).
  let cTotal = 0;
  let cHit = 0;
  for (const t of c._tokens) {
    const wq = listingWordWeight(t, u);
    if (!wq) continue;
    cTotal += wq;
    if (q._tokens.has(t) || scored.some((w) => wordSpellsLike(w, t))) cHit += wq;
  }
  const cCov = cTotal ? cHit / cTotal : 1;

  // The listing must carry one of the query's most distinctive words, and
  // must not have swapped one for something else.
  const top = scored.slice(0, scored.length >= 3 ? 2 : 1);
  const anchored = sharedCode || !top.length || top.some((w) => present.has(w.token));
  if (!anchored) return null;
  if (relevanceVeto(u, c)) return null;

  const evidence = sharedCode || specsAgree(q._specs, c._specs);
  // A size the listing doesn't state can't count towards identifying it:
  // "Kitkat 160g" against a size-less "KitKat Brownies (6 Pcs)" is one word.
  if (!evidence && scored.length + u.numbers.size + u.codes.size < 2) return null;
  const blended = Math.min(1, 0.6 * qCov + 0.4 * cCov);
  const strict =
    evidence && ((qCov >= 0.85 && cCov >= 0.4) || (cCov >= 0.85 && qCov >= 0.5));
  if (strict) {
    return { kind: 'strict', rate: Math.round(100 * Math.max(blended, 0.7)), value: 10 + blended + (sharedCode ? 1 : 0) };
  }
  const leads = leadsWithQuery(tokenSequence(q.name), tokenSequence(c.name), c._tokens);
  // A brand-less, descriptive query ("sunscreen kids") is fully contained in
  // a branded listing ("Caribbean Breeze 30 Kids Sunscreen 120ml"), which says
  // plenty the query never mentions — every word asked for IS there, so it
  // doesn't need to lead the title. Needs two words so a lone word can't do it.
  const fullyContained = qCov >= 0.99 && scored.length >= 2 && cCov >= 0.15;
  if (qCov >= 0.75 && cCov >= 0.2 && (leads || cCov >= 0.6 || fullyContained)) {
    return { kind: 'broad', rate: Math.round(Math.min(RELEVANCE_BROAD_MAX_RATE, 100 * blended)), value: blended };
  }
  return null;
}
