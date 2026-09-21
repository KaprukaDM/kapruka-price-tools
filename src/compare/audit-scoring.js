// Shared product-matching logic for every category's match-local.js
// (electronics/cosmetics/home-lifestyle/sports-audit) — previously
// duplicated near-identically in each, which meant a fix here had to be
// hand-copied four times and would silently drift out of sync.

import { codesMatch, specsConflict, SPEC_TOKEN } from './normalize.js';

export const CODE_MATCH_MIN_OVERLAP = 0.15;
export const MIN_INTERSECTION = 2;

// Products named purely by spec, with no SKU-style code at all ("Galaxy Tab
// S9 FE 5G 6GB 128GB"), would otherwise never match anything under the
// exact-code rule — even when every side clearly agrees. This fallback
// path needs a much higher name-overlap bar than the code path (0.65 vs
// 0.15) since there's no SKU to lean on for confidence.
export const FALLBACK_MIN_OVERLAP = 0.65;

// Applies only when NEITHER side has any recognized spec (see scoreCandidate)
// — token containment is the sole safeguard then, so a short generic name
// ("Kitchen Rack", 2 tokens) needs a higher bar than the general MIN_INTERSECTION
// to actually mean something.
//
// Was 4 — but that floor is mathematically unreachable for any 3-token query
// (intersection can never exceed the smaller side's token count), so every
// spec-less 3-word query ("kids study table") got silently rejected against
// real, verbose marketplace titles no matter how good the match was — only
// escaping via the exactSameTokens case, i.e. pure luck that a candidate's
// title happened to tokenize to exactly 3 words too. Lowered to 3: still
// unreachable for a 2-token query like "Kitchen Rack" (the case this const
// was introduced for — confirmed it still rejects "Wall Mounted Kitchen And
// Bathroom Metal Shelf Rack"), while letting a genuinely specific 3-word
// query match a full-containment candidate instead of requiring a 4th word
// that doesn't exist anywhere in the query.
export const SPEC_LESS_MIN_INTERSECTION = 3;

export function overlapCoefficient(a, b) {
  if (a.size === 0 || b.size === 0) return { overlap: 0, intersection: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return { overlap: inter / Math.min(a.size, b.size), intersection: inter };
}

export function sharedCodeCount(aCodes, bCodes) {
  let n = 0;
  for (const a of aCodes) for (const b of bCodes) if (codesMatch(a, b)) { n++; break; }
  return n;
}

export function versionNumbers(name) {
  return new Set((String(name || '').match(/\b\d{1,2}\b/g) || []));
}

// True if the two spec maps positively agree on at least one real value
// (not just "no conflict" — specsConflict(a,b)===false is also true when
// neither side has any specs at all, which shouldn't be enough on its own
// to accept a code-less match).
function hasAgreeingSpec(a, b) {
  for (const unit of Object.keys(a)) {
    const bv = b[unit];
    if (!bv) continue;
    for (const v of a[unit]) if (bv.has(v)) return true;
  }
  return false;
}

// Overlap coefficient is dangerously easy to max out on SHORT names: "Kejo
// Turmeric Face Wash 100ml" (5 tokens) vs an unrelated "C&C Face Wash 100Ml"
// (3 tokens after stopwords) shares {face, wash, 100ml} = intersection 3,
// min-size 3 -> overlap 1.0, despite being a completely different product —
// the smaller side is almost entirely generic category words. It's also
// blind to a digit glued directly to a letter ("Redmi 13C" vs "Redmi 15C")
// or a word-based variant suffix ("iPhone 16" vs "16 Pro") — a couple of
// shared generic tokens can outweigh one differing distinctive one.
//
// The general fix: every token in Kapruka's name that ISN'T a recognized
// pure-spec token (128gb, 1000w, 5g — those are separately checked via
// hasAgreeingSpec/specsConflict, which tolerate a spec being merely absent
// from a terser competitor listing) must appear verbatim on the competitor
// side. This is a single principled rule that catches brand mismatches
// (kejo -> missing), model-number mismatches (200 -> missing, 13c -> missing
// since "15c" is a different token), and scent/flavour-variant mismatches
// (charming -> missing since "alluring" is a different token) all at once —
// far more general than trying to special-case "the first token is probably
// the brand" (breaks on category-first names like "Thermos Flask Mondi") or
// hand-listing "qualifier words" one industry at a time.
//
// A common color word is exempted: a competitor listing frequently omits
// color ("Honor X6C (6GB/128GB)" vs Kapruka's "...White") without being a
// different product/price, unlike a model number or brand.
const COLOR_WORDS = new Set([
  'white', 'black', 'blue', 'red', 'green', 'silver', 'gold', 'grey', 'gray',
  'pink', 'purple', 'yellow', 'orange', 'brown', 'titanium', 'graphite',
  'aqua', 'turquoise', 'teal', 'cyan', 'navy', 'maroon', 'beige', 'cream',
  'lavender', 'mint', 'coral', 'ivory', 'magenta', 'violet',
]);

// A bare measurement WORD ("inch", "cm", "kg") carries no identity on its own
// -- the number in front of it does, and that number is checked as an
// ordinary token like any other. Without this, "Hisense 55 Inch ... TV" could
// never match a listing that writes the same size as `55"` or just "55",
// because "inch" read as a distinctive word the other side was missing.
// Deliberately only the spelled-out unit words; anything attached to a number
// ("55inch", "1000w") is already handled by SPEC_TOKEN.
const UNIT_WORDS = new Set([
  'inch', 'inches', 'cm', 'mm', 'kg', 'ml', 'ltr', 'litre', 'liter', 'litres',
  'liters', 'gram', 'grams', 'watt', 'watts', 'volt', 'volts', 'btu',
]);

// Kapruka's electronics names routinely end with the full SKU ("Hisense A6
// Series 55 Inch 4K UHD Smart TV 55A61H") while the competitor's shorter
// title spells the same identity out in words ("Hisense 55 Inch A6 Series 4K
// UHD Smart TV") and gives no code at all. Treating that SKU as an ordinary
// distinctive word rejected an otherwise 100%-overlap match on one token.
//
// The waiver is never unconditional. It requires ALL of:
//   1. the competitor states no model code of its own — if it does and none of
//      them matched (this path only runs with 0 shared codes), that's positive
//      evidence of a DIFFERENT SKU, not just a terser title;
//   2. every other distinctive Kapruka word is still present verbatim, plus
//      the usual overlap/version-number bars (unchanged, checked by the
//      caller) — so "43" vs "55", "A6" vs "A7" and a different brand all keep
//      rejecting exactly as before;
//   3. one of two positive anchors, since dropping a SKU from the comparison
//      has to be paid for with evidence:
//      a) the competitor's own words ACCOUNT for what the code is made of:
//         strip each competitor token that appears inside the code (longest
//         first) and the leftover must be a generation/region stub of <=2
//         characters, with >=4 characters accounted for. "55a61h" minus "55"
//         minus "a6" leaves "1h" -> waived; "au7700" against a listing that
//         just says "Samsung 55 Inch 4K Smart TV" is unaccounted for -> still
//         rejected, so a code that is the ONLY thing distinguishing two models
//         can't be waved through; or
//      b) both sides state the SAME measurable spec ("Innovex Rice Cooker 1.5L
//         (IRC159)" vs "Innovex Rice Cooker (1.5L)", "Panasonic ... 23L
//         (NNGT342M)" vs "Panasonic 23L Microwave Oven Grill"). A shared
//         capacity/wattage figure is independent confirmation the two listings
//         describe the same item; a spec-less pair ("Philips Sandwich Maker
//         HD2393" vs "Philips Sandwich Maker") has no such anchor and stays
//         rejected.
const CODE_RESIDUE_MAX = 2;
const CODE_EXPLAINED_MIN_CHARS = 4;
function codeExplainedBy(code, cTokens) {
  let rest = code;
  for (const t of [...cTokens].sort((a, b) => b.length - a.length)) {
    if (t.length < 2) continue;
    const i = rest.indexOf(t);
    if (i !== -1) rest = rest.slice(0, i) + rest.slice(i + t.length);
  }
  return rest.length <= CODE_RESIDUE_MAX && code.length - rest.length >= CODE_EXPLAINED_MIN_CHARS;
}

// Which tokens may be waived by the `waive` budget below (see
// scoreCandidate's `waiveUnmatched` option). Deliberately only plain words --
// a brand ("sony"), a category word ("console"), a descriptor. Anything
// carrying a digit (a model number, a SKU, a capacity) and anything in the
// product-line qualifier list ("pro", "max", "lite") is never waivable: those
// are exactly what tells two products of the same family apart.
function isWaivableWord(t) {
  return !/\d/.test(t) && !QUALIFIER_WORDS.has(t);
}

function unmatchedDistinctiveToken(kTokens, cTokens, { kCodes, cCodes, specsAgree, waive = 0 } = {}) {
  const canWaiveCodes = Boolean(kCodes && cCodes && cCodes.size === 0);
  let budget = waive;
  for (const t of kTokens) {
    if (COLOR_WORDS.has(t) || UNIT_WORDS.has(t) || SPEC_TOKEN.test(t)) continue;
    if (cTokens.has(t)) continue;
    if (canWaiveCodes && kCodes.has(t) && (specsAgree || codeExplainedBy(t, cTokens))) continue;
    if (budget > 0 && isWaivableWord(t)) { budget--; continue; }
    return t;
  }
  return null;
}

// The rule above only checks Kapruka's tokens against the competitor's, so
// it misses the reverse case where the COMPETITOR carries an extra
// distinguishing suffix Kapruka's name doesn't have at all ("iPhone 16" vs
// competitor's "iPhone 16 Pro" — "16" is on both sides, "pro" is only on
// the competitor's, so nothing above catches it). Reject on that asymmetry
// for a small curated set of common product-line qualifier words.
const QUALIFIER_WORDS = new Set([
  'pro', 'plus', 'max', 'ultra', 'lite', 'mini', 'se', 'neo', 'air', 'note', 'prime', 'edge',
]);
function qualifierMismatch(a, b) {
  for (const w of QUALIFIER_WORDS) {
    if (a.has(w) !== b.has(w)) return true;
  }
  return false;
}

// A phone/gadget's own name is a substring of virtually every accessory
// listing for it ("iPhone 15 Silicone Case" contains "iPhone 15" in full),
// so a query for the device alone was passing every one of scoreCandidate's
// other checks against a case/cover/charger listing -- high token overlap,
// no conflicting spec, no unmatched qualifier word. A case is never the same
// product as the device it protects, no matter how strong the rest of the
// match looks, so this is checked unconditionally (both the code and
// no-code branches) rather than folded into either path's own bar. Doesn't
// fire when the QUERY itself is for the accessory ("iPhone 15 case") --
// only when the accessory word appears on just one side.
const ACCESSORY_WORDS = new Set([
  'case', 'cover', 'pouch', 'sleeve', 'skin', 'sticker', 'decal', 'tempered',
  'protector', 'charger', 'cable', 'adapter', 'holder', 'mount', 'stand',
  'strap', 'bumper', 'magsafe', 'lanyard', 'shell', 'casing',
  // Console accessories: a query for the console itself ("PlayStation 5")
  // is a substring of virtually every accessory listing for it ("Sony
  // PlayStation 5 DualSense Wireless Controller"/"...Joystick"), same
  // failure mode as the phone-case case above -- confirmed live on the
  // price checker, a PS5 search was matching a PS5 joystick listing.
  'joystick', 'controller', 'gamepad', 'headset', 'earphone', 'earphones',
  'earbud', 'earbuds', 'dock', 'docking', 'remote', 'faceplate',
  'thumbstick', 'thumbgrip', 'grip', 'grips',
  // Companion products that sell FOR a console and whose titles quote the
  // console's full name: a game ("Call of Duty – PlayStation 5", LKR 15k), a
  // charging station, a spare disc drive. Without these, a generic console
  // query pulled LKR 13k game discs into the same table as LKR 180k consoles,
  // and the cheapest of them became the price the insight anchors on.
  'game', 'games', 'drive', 'charging', 'station', 'bundle',
]);

// A few of the words above are only a companion-product signal when the query
// isn't itself about that kind of product. "Drive" next to a console means a
// spare disc drive; next to "SanDisk Cruzer Blade 32GB" it's the product
// itself. So 'drive' only vetoes when the query says nothing about storage —
// either a storage word or a bare capacity token ("32gb", "1tb"). The
// blanket query-side exemption below (hasAnyAccessoryWord) already covers the
// case where the query spells the word out; this covers the case where it
// clearly means the same category without using that exact word.
const CAPACITY_TOKEN = /^\d+(gb|tb|mb)$/;
const CONTEXT_WORDS = {
  drive: new Set(['ssd', 'hdd', 'nvme', 'sata', 'usb', 'flash', 'pen', 'portable', 'external', 'storage', 'sd', 'microsd', 'hard', 'thumb', 'enclosure']),
};
function contextExempt(word, qTokens) {
  const ctx = CONTEXT_WORDS[word];
  if (!ctx) return false;
  for (const t of qTokens) if (ctx.has(t) || CAPACITY_TOKEN.test(t)) return true;
  return false;
}
// Per-word exemption ("query has 'cover', candidate also has 'cover'" ->
// fine) missed the common case of two DIFFERENT accessory words meaning the
// same kind of thing -- a "iPhone 12 cover" query against a listing titled
// "...Armor Case" still rejected, since "cover" exempts only itself, not
// "case" (confirmed live: this alone was reducing real cover searches to
// zero results). Once the query names ANY accessory word at all, treat it
// as accessory-shopping intent and stop rejecting on this category
// entirely -- the query is for *an* accessory, matching on the specific
// wording of which kind is what the rest of scoreCandidate()'s overlap/
// jaccard checks are for, not this veto.
function hasAnyAccessoryWord(tokens) {
  for (const w of ACCESSORY_WORDS) if (tokens.has(w)) return true;
  return false;
}
export function accessoryMismatch(kTokens, cTokens) {
  if (hasAnyAccessoryWord(kTokens)) return false;
  for (const w of ACCESSORY_WORDS) {
    if (!cTokens.has(w)) continue;
    if (contextExempt(w, kTokens)) continue;
    return true;
  }
  return false;
}

// True if the candidate is an accessory listing at all, ignoring whether the
// query happens to share that word. accessoryMismatch()'s query-side
// exemption exists for a real case (a query that IS for the accessory,
// "iPhone 15 case"), but backfires when the query's own product just
// happens to use an accessory word to describe ITSELF ("kids toothbrush
// ... with cute cover" — "cover" here is the toothbrush's own cap, not a
// request for phone covers) — the exemption then waves through every
// phone-case-type listing that also contains "cover" as an unrelated
// low-confidence "closest match". Use this stricter check instead of
// accessoryMismatch() in contexts that don't independently verify the
// query and candidate are even the same product (e.g. a same-brand/
// category fallback when nothing scored a confident match) — a genuine
// accessory query almost always matches confidently in the normal path
// anyway, so this rarely costs real recall there.
export function isAccessoryListing(cTokens) {
  for (const w of ACCESSORY_WORDS) {
    if (cTokens.has(w)) return true;
  }
  return false;
}

// Single-word version of the above check — used to avoid building a search
// query anchored on an accessory word that's just describing the query's
// OWN product ("kids toothbrush ... with cute cover" -> a naive "brand +
// last word" heuristic would search "cover", which on a marketplace mostly
// surfaces phone covers, not the toothbrush).
export function isAccessoryWord(word) {
  return ACCESSORY_WORDS.has(String(word || '').toLowerCase());
}

// "Does this product's name contain what the user typed" — a relevance
// filter, not the identity check scoreCandidate() performs. Used by the
// Price Checker, where the `k` side is a phrase a human typed rather than a
// Kapruka product name, so a short query ("playstation 5") that can never
// reach MIN_INTERSECTION-style bars still finds the real catalogue rows.
// `waive` allows at most N plain words the user typed to be absent from the
// candidate (see isWaivableWord) — that's what makes "Sony playstation 5"
// and "playstation 5" land on the same products instead of two different
// answers. Numbers, SKUs and qualifier words are never waivable, and a
// candidate carrying a qualifier the query doesn't ("... 5 Pro") is still
// rejected, so the waiver can't quietly blend two product tiers together.
// Returns null (no match) or { overlap, intersection }, where overlap is the
// fraction of the typed words actually found.
export function broadNameMatch(qTokens, cTokens, { waive = 0, qSeq, cSeq } = {}) {
  if (!qTokens.size) return null;
  if (accessoryMismatch(qTokens, cTokens)) return null;
  if (qualifierMismatch(qTokens, cTokens)) return null;
  let budget = waive;
  let matched = 0;
  for (const t of qTokens) {
    if (cTokens.has(t)) { matched++; continue; }
    if (budget > 0 && isWaivableWord(t)) { budget--; continue; }
    return null;
  }
  if (matched < MIN_INTERSECTION) return null;
  if (qSeq && cSeq && !leadsWithQuery(qSeq, cSeq, cTokens)) return null;
  return { overlap: matched / qTokens.size, intersection: matched };
}

// A product listing LEADS with the product ("Sony PlayStation 5 Slim
// Console"); a listing for something that merely works with it names itself
// first and mentions the product later ("Dobe Cooling Fan For PlayStation 5",
// "Spider-Man Miles Morales - PlayStation 5", "Call of Duty ... PlayStation
// 5"). With no code or spec agreement to lean on, word containment alone
// can't tell those apart — which is how LKR 7k-15k game discs ended up in
// the same table as LKR 180k consoles, dragging the suggested price down.
// So a broad match additionally requires the words the user typed to appear
// in the listing's title IN THE ORDER THEY TYPED THEM, starting within the
// first few words. Word-list-free and product-agnostic: it's a rule about
// where a title puts its own subject, not about any particular product.
const BROAD_MAX_LEAD_WORDS = 2; // room for a brand ("Sony") and one adjective
export function leadsWithQuery(qSeq, cSeq, cTokens) {
  // Only the query words the candidate actually has: a waived word (a brand
  // the listing omits) can't be positioned, and shouldn't break the order.
  const wanted = qSeq.filter((t) => cTokens.has(t));
  if (!wanted.length) return false;
  const start = cSeq.indexOf(wanted[0]);
  if (start < 0 || start > BROAD_MAX_LEAD_WORDS) return false;
  let at = start;
  for (let i = 1; i < wanted.length; i++) {
    const next = cSeq.indexOf(wanted[i], at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

// k/c are indexed products (see matcher.js's index()) with ._tokens,
// ._codes, ._specs already computed. Returns null (reject) or
// { value, codes, overlap } for ranking candidates against one Kapruka
// product — the highest `value` wins.
//
// opts.waiveUnmatched (default 0, i.e. unchanged behaviour for every audit/
// comparison caller): allow up to N plain words on the `k` side to be absent
// from the candidate. Only the Price Checker sets it, because there `k` is a
// typed query, not a product title — the brand word someone did or didn't
// type shouldn't decide whether the catalogue has the product.
export function scoreCandidate(k, c, opts = {}) {
  const waiveUnmatched = opts.waiveUnmatched || 0;
  const codes = sharedCodeCount(k._codes, c._codes);
  const { overlap, intersection } = overlapCoefficient(k._tokens, c._tokens);
  if (intersection < MIN_INTERSECTION || specsConflict(k._specs, c._specs)) return null;
  if (accessoryMismatch(k._tokens, c._tokens)) return null;

  if (codes >= 1) {
    if (overlap < CODE_MATCH_MIN_OVERLAP) return null;
  } else {
    // No code on either side — only accept with strong name overlap, every
    // Kapruka-side distinctive token present verbatim on the competitor side
    // (see unmatchedDistinctiveToken() above), and no one-sided qualifier
    // word (16 must not silently pass as 16 Pro). When EITHER side has a
    // recognized spec (128GB, 1000W, 130g — extractSpecs' unit list),
    // additionally require the two sides to positively agree on at least
    // one, not just fail to conflict — e.g. a shared "256GB" figure that's
    // actually two different RAM tiers. If NEITHER side has any recognized
    // spec at all (common for confectionery/gift items with no measurable
    // dimension), this extra bar doesn't apply — token containment alone
    // carries the weight, since requiring "agreement" on nothing meant an
    // exact-name match with no spec anywhere was rejected outright.
    const eitherHasSpecs = Object.keys(k._specs).length > 0 || Object.keys(c._specs).length > 0;
    if (overlap < FALLBACK_MIN_OVERLAP) return null;
    if (eitherHasSpecs && !hasAgreeingSpec(k._specs, c._specs)) return null;
    // With no spec to lean on at all, token containment is the ONLY thing
    // stopping a false positive — and a bare 2-token Kapruka name ("Kitchen
    // Rack", "Toothbrush Holder") is trivially "contained" in nearly any
    // same-category listing, since there's nothing distinctive to fail to
    // contain. "Kitchen Rack" -> "Wall Mounted Kitchen And Bathroom Metal
    // Shelf Rack" at a 6.5x price difference is exactly that failure mode —
    // the competitor's EXTRA tokens ("wall mounted", "metal", "bathroom")
    // describe a different, unverified product. A genuinely IDENTICAL short
    // name ("Shopping Bag Holder" == "Shopping Bag Holder") is fine at any
    // length though — there's no unverified extra content to worry about,
    // so only apply the higher bar when the competitor's side carries tokens
    // beyond what Kapruka's name already vouches for.
    const exactSameTokens = k._tokens.size === c._tokens.size && intersection === k._tokens.size;
    if (!eitherHasSpecs && !exactSameTokens && intersection < SPEC_LESS_MIN_INTERSECTION) return null;
    // Kapruka's own SKU ("...Smart Tv 55A61H") is the one distinctive token a
    // terser competitor title routinely omits — see the waiver conditions on
    // unmatchedDistinctiveToken(). specsAgree is already guaranteed true here
    // whenever either side has specs (checked just above), so it's passed
    // through rather than recomputed.
    if (
      unmatchedDistinctiveToken(k._tokens, c._tokens, {
        kCodes: k._codes,
        cCodes: c._codes,
        specsAgree: eitherHasSpecs && hasAgreeingSpec(k._specs, c._specs),
        waive: waiveUnmatched,
      })
    ) {
      return null;
    }
    if (qualifierMismatch(k._tokens, c._tokens)) return null;
    // A standalone 1-2 digit count ("3 Burner" vs "4 Burner", "JBL Xtreme 4"
    // vs "5") used to only cost -0.5 on the ranking score, which doesn't
    // reject anything — it only affects which of several ACCEPTED candidates
    // wins "best" on a given site. If a mismatched one is the only candidate
    // that clears the other bars, the penalty alone let it through anyway.
    const kv = versionNumbers(k.name);
    const cv = versionNumbers(c.name);
    if (kv.size && cv.size && ![...kv].some((v) => cv.has(v))) return null;
  }

  const kVersions = versionNumbers(k.name);
  const cVersions = versionNumbers(c.name);
  const versionAgrees = [...kVersions].some((v) => cVersions.has(v));
  const versionBonus = kVersions.size && cVersions.size ? (versionAgrees ? 0.05 : -0.5) : 0;
  // A listing that shares Kapruka's actual SKU outranks one that merely
  // describes the same thing in words, whatever their name overlap. Ranking
  // used to be name-overlap only, so a verbose competitor title carrying the
  // exact model code ("Philips Electric Kettle - HD9303/03") could lose "best
  // match on this site" to a tidier code-less title, and that got noticeably
  // more likely once a missing code stopped being an automatic rejection
  // above. Big enough (1.0) that no overlap difference can outweigh a shared
  // code — the same evidence ranking match_confidence high/medium already uses.
  const codeBonus = codes >= 1 ? 1 : 0;
  return { value: 1 + overlap + versionBonus + codeBonus, codes, overlap };
}
