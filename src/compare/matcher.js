// Match a Kapruka catalogue against the partner's own-site catalogue and bucket
// the result into:
//   matched      - product found on both sites (+ price comparison)
//   onlyKapruka  - listed on our Kapruka page, NOT found on the partner site
//   onlyPartner  - on the partner site, NOT listed on our Kapruka page
//
// Matching uses a shared strong model code (high confidence) and/or descriptive
// token overlap (Jaccard). See normalize.js for how codes/tokens are derived.

import { tokenize, extractModelCodes, extractNativeModelCodes, codesMatch, extractSpecs, specsConflict, normalizeName } from './normalize.js';

// Adult-wellness listings lean so heavily on generic shared vocabulary
// (vibrator, silicone, anal, sex toys...) that plain name-overlap routinely
// conflates genuinely different items -- e.g. a 3-piece graduated-size set
// vs. a single "Medium" item that shares every other word. Scoped to this
// category specifically (rather than changing shared spec-matching used by
// every other tool): also require the stated quantity ("3 Pcs", "Pack of 2")
// to agree. A name with no quantity word defaults to 1, since these are
// almost always sold individually unless the listing says otherwise.
// Word-boundary regexes, not bare .includes() -- a naive substring check
// falsely fired on "fighting spot" (contains "g spot") and on unrelated
// products that legitimately use a generic word like "vibrator" (a concrete
// vibrator) or "lubricant" (engine de-ruster). Kept fairly specific: broad
// single words like bare "lubricant" are dropped since ordinary hardware/
// automotive listings use them constantly.
const ADULT_CATEGORY_PATTERNS = [
  /\bvibrators?\b/, /\bdildos?\b/, /\banal\b/, /\bvaginal?\b/, /\bpenis\b/,
  /\bcondoms?\b/, /\bmasturbat\w*\b/, /\bbdsm\b/, /\bbutt[\s-]?plugs?\b/,
  /\bcock[\s-]?ring\b/, /\bsex[\s-]?toys?\b/, /\bfleshlight\b/,
  /\bg[\s-]?spot\b/, /\bclitoris\b/, /\bejaculat\w*\b/, /\bdilators?\b/,
  /\bnipple[\s-]?clamps?\b/, /\blove[\s-]?doll\b/, /\bbondage\b/,
];
function isAdultToyName(name) {
  const n = String(name || '').toLowerCase();
  return ADULT_CATEGORY_PATTERNS.some((re) => re.test(n));
}
function extractQty(name) {
  const m = normalizeName(name).match(/\b(\d+)\s*(?:pcs?|pieces?|pack|set)\b/);
  return m ? parseInt(m[1], 10) : 1;
}

// Generic quality/marketing descriptors that a listing may drop or add
// without being a different product ("Organic Apple Cider Vinegar" vs
// "Apple Cider Vinegar" is the same item, just described differently).
const DESCRIPTOR_WORDS = new Set(['organic', 'natural', 'pure', 'premium', 'fresh', 'virgin', 'raw']);

// A leftover token in `a` that ISN'T in `b` and isn't a mere descriptor is a
// real ingredient/variant difference (e.g. "... With The Mother 500ml" vs
// "... With The Mother And Organic Honey 500ml" -- "honey" names an added
// second ingredient, a genuinely different product, not just a wording
// difference). Two near-duplicate names differing by exactly one such word
// can still clear NAME_ONLY_JACCARD (only a couple of tokens out of many),
// and worse, the variant WITH the extra word can score a *higher* jaccard
// than the correct match if the competitor listing itself omits a
// descriptor -- so this can't be left to the jaccard threshold alone.
function unmatchedToken(aTokens, bTokens) {
  for (const t of aTokens) {
    if (DESCRIPTOR_WORDS.has(t)) continue;
    if (!bTokens.has(t)) return t;
  }
  return null;
}

// Prices within this fraction of each other are treated as "same".
const SAME_PRICE_TOLERANCE = 0.01;
// Pure-name matches (no shared model code) need at least this token overlap.
const NAME_ONLY_JACCARD = 0.55;
// A model-code match still needs a little descriptive overlap to guard against
// the rare case of two unrelated products sharing the same product-line code
// (e.g. a Meetion "C510" keyboard vs a Sony "C510" earbud). Real matches almost
// always share more than this; pure code-collisions score below it.
const CODE_MATCH_MIN_JACCARD = 0.12;
// A code match clearing only CODE_MATCH_MIN_JACCARD (as low as 12%) is still
// accepted as a match, but isn't strong enough evidence to label "high"
// confidence on its own — a shared code plus a mostly-different name is worth
// a human glance. Only label "high" once the name overlap is convincingly
// above the bare acceptance floor too.
const HIGH_CONFIDENCE_MIN_JACCARD = 0.3;
// A pure-name match with near-total token overlap and no code at all is, on
// its own, as strong a signal as a code match — two listings that use almost
// exactly the same words are the same product. Without this, a 100%
// name-similarity match still landed in "medium" (shown as "needs review")
// purely for lacking a model code, sending obviously-correct matches to
// manual review while genuinely uncertain ones went unflagged.
const NAME_ONLY_HIGH_CONFIDENCE_JACCARD = 0.9;

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function sharedCodeCount(aCodes, bCodes) {
  let n = 0;
  for (const a of aCodes) for (const b of bCodes) if (codesMatch(a, b)) { n++; break; }
  return n;
}

// Precompute tokens/codes once per product. stopnshop SKUs often embed the
// model code (e.g. "Philips_BHD340"), so the SKU is folded into the CODE
// signal. It's deliberately kept OUT of the descriptive-word token set,
// though: an internal inventory SKU with no embedded code at all (e.g.
// "GH/19/1474") still tokenizes into "gh"/"19"/"1474" noise words, which
// dilutes the Jaccard word-overlap score -- for a short product name (2-3
// words), a couple of extra SKU-derived tokens is enough to drag an exact,
// identical-text match below NAME_ONLY_JACCARD and reject it outright
// (verified: "Shapes Board" == "Shapes Board" scored a perfect 1.0 jaccard
// on names alone, but null once "GH/19/1474" got folded into both sides'
// tokens). Exported for the same reason as score() above — small per-query
// candidate sets need the same precomputation as a full catalogue index.
export function index(products, withSku) {
  return products.map((p) => {
    const codeText = withSku ? `${p.name} ${p.sku || ''}` : p.name;
    return {
      ...p,
      _tokens: tokenize(p.name),
      _codes: extractModelCodes(codeText),
      _nativeCodes: extractNativeModelCodes(codeText),
      _specs: extractSpecs(p.name),
    };
  });
}

// Score one Kapruka product against one stopnshop product. Exported so callers
// that only have a small per-query candidate set (e.g. a competitor site's own
// search results for one product, rather than that site's full catalogue) can
// reuse the same code/name/spec-conflict scoring without building a full
// matchCatalogs() index of both sides.
export function score(k, s) {
  const codes = sharedCodeCount(k._codes, s._codes);
  const nativeCodes = sharedCodeCount(k._nativeCodes, s._nativeCodes);
  const jac = jaccard(k._tokens, s._tokens);
  // Conflicting specs (different wattage/capacity/tyre size ⇒ different
  // product) veto a pure-name match. A code match is normally trusted over a
  // spec conflict (the code is stronger evidence, and spec-parsing itself
  // has known blind spots — e.g. a decimal point already lost upstream in
  // the source name). But that trust only holds for a *native* code, already
  // fused as one token in the source text (e.g. "HD9373"). A code that only
  // exists because the prefix+digits join glued two separate words together
  // (extractNativeModelCodes vs. extractModelCodes in normalize.js) is much
  // weaker: the same join that turns "NF 9269" into "nf9269" also turns "MRF
  // 100" (a tyre brand followed by its width, not a SKU) into "mrf100",
  // making two differently-sized tyres of the same brand look like a strong
  // code match — so a conflicting spec still vetoes those.
  const conflict = specsConflict(k._specs, s._specs);
  const codeMatch = codes >= 1 && jac >= CODE_MATCH_MIN_JACCARD && (nativeCodes >= 1 || !conflict);
  const nameMatch =
    jac >= NAME_ONLY_JACCARD &&
    !conflict &&
    !unmatchedToken(k._tokens, s._tokens) &&
    !unmatchedToken(s._tokens, k._tokens);
  if (!codeMatch && !nameMatch) return null;
  if ((isAdultToyName(k.name) || isAdultToyName(s.name)) && extractQty(k.name) !== extractQty(s.name)) {
    return null;
  }
  // Code matches rank above pure-name matches; ties broken by token overlap.
  return { value: (codes >= 1 ? 1 : 0) + jac, codes, jaccard: jac };
}

function priceComparison(k, s) {
  const kp = k.price;
  const sp = s.price;
  if (kp == null || sp == null) {
    return { verdict: 'price_missing', diff: null, pct: null };
  }
  const diff = kp - sp; // +ve => Kapruka is more expensive
  const pct = sp ? (diff / sp) * 100 : null;
  let verdict;
  if (Math.abs(diff) <= sp * SAME_PRICE_TOLERANCE) verdict = 'same';
  else if (diff > 0) verdict = 'kapruka_higher'; // overpriced on our site
  else verdict = 'kapruka_lower';
  return { verdict, diff, pct };
}

// Roll a matchCatalogs() result up into headline counts.
export function summarize({ matched, onlyKapruka, onlyPartner }) {
  const by = (v) => matched.filter((m) => m.verdict === v).length;
  return {
    matched: matched.length,
    same: by('same'),
    kaprukaHigher: by('kapruka_higher'),
    kaprukaLower: by('kapruka_lower'),
    priceMissing: by('price_missing'),
    onlyKapruka: onlyKapruka.length,
    onlyPartner: onlyPartner.length,
  };
}

export function matchCatalogs(kapruka, partner) {
  const kIndexed = index(kapruka, false);
  const pIndexed = index(partner, true);

  // Every (Kapruka product, partner product) pair that clears score()'s bar
  // is a *candidate*, not a match yet. Picking each Kapruka product's best
  // candidate independently (the old approach) let the same partner product
  // get claimed by several different Kapruka products — e.g. every "Slim Fit
  // Shirt" on Kapruka all landing on the one generic "Slim Fit Shirt" listing
  // on the partner site. Matching must be one-to-one: rank every candidate
  // pair by score globally, then assign greedily, skipping a pair the moment
  // either side has already been claimed by a stronger-scoring pair.
  const candidates = [];
  for (const k of kIndexed) {
    for (const p of pIndexed) {
      const sc = score(k, p);
      if (sc) candidates.push({ k, p, sc });
    }
  }
  candidates.sort((a, b) => b.sc.value - a.sc.value);

  const matched = [];
  const usedKapruka = new Set();
  const usedPartner = new Set();

  for (const { k, p, sc } of candidates) {
    if (usedKapruka.has(k) || usedPartner.has(p)) continue;
    usedKapruka.add(k);
    usedPartner.add(p);
    const price = priceComparison(k, p);
    matched.push({
      name: k.name,
      kaprukaUrl: k.url,
      kaprukaPrice: k.price,
      kaprukaInStock: k.inStock !== false,
      partnerName: p.name,
      partnerUrl: p.url,
      partnerSku: p.sku,
      partnerBrand: p.brand || '',
      partnerCategory: p.category || '',
      partnerPrice: p.price,
      partnerRegularPrice: p.regularPrice,
      partnerInStock: p.inStock !== false,
      confidence:
        (sc.codes >= 1 && sc.jaccard >= HIGH_CONFIDENCE_MIN_JACCARD) ||
        sc.jaccard >= NAME_ONLY_HIGH_CONFIDENCE_JACCARD
          ? 'high'
          : 'medium',
      sharedCodes: sc.codes,
      nameSimilarity: Math.round(sc.jaccard * 100),
      ...price,
    });
  }

  const matchedKaprukaUrls = new Set(matched.map((m) => m.kaprukaUrl));
  const onlyKapruka = kIndexed
    .filter((k) => !matchedKaprukaUrls.has(k.url))
    .map((k) => ({ name: k.name, price: k.price, url: k.url }));
  const onlyPartner = pIndexed
    .filter((p) => !usedPartner.has(p))
    .map((p) => ({ name: p.name, sku: p.sku, price: p.price, url: p.url, brand: p.brand || '', category: p.category || '' }));

  return { matched, onlyKapruka, onlyPartner };
}
