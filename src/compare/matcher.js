// Match a Kapruka catalogue against the partner's own-site catalogue and bucket
// the result into:
//   matched      - product found on both sites (+ price comparison)
//   onlyKapruka  - listed on our Kapruka page, NOT found on the partner site
//   onlyPartner  - on the partner site, NOT listed on our Kapruka page
//
// Matching uses a shared strong model code (high confidence) and/or descriptive
// token overlap (Jaccard). See normalize.js for how codes/tokens are derived.

import { tokenize, extractModelCodes, codesMatch, extractSpecs, specsConflict } from './normalize.js';

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

// Precompute tokens/codes once per product. stopnshop SKUs often embed the model
// code (e.g. "Philips_BHD340"), so we fold the SKU into both signals. Exported
// for the same reason as score() above — small per-query candidate sets need
// the same precomputation as a full catalogue index.
export function index(products, withSku) {
  return products.map((p) => {
    const text = withSku ? `${p.name} ${p.sku || ''}` : p.name;
    return {
      ...p,
      _tokens: tokenize(text),
      _codes: extractModelCodes(text),
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
  const jac = jaccard(k._tokens, s._tokens);
  // A shared model code is strong identity. A pure-name match is weaker, so we
  // additionally reject it when the two names carry conflicting specs (different
  // wattage/capacity ⇒ different product).
  const codeMatch = codes >= 1 && jac >= CODE_MATCH_MIN_JACCARD;
  const nameMatch = jac >= NAME_ONLY_JACCARD && !specsConflict(k._specs, s._specs);
  if (!codeMatch && !nameMatch) return null;
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

  const matched = [];
  const usedPartner = new Set();

  for (const k of kIndexed) {
    let best = null;
    for (const p of pIndexed) {
      const sc = score(k, p);
      if (sc && (!best || sc.value > best.sc.value)) best = { p, sc };
    }
    if (best) {
      usedPartner.add(best.p.id);
      const price = priceComparison(k, best.p);
      matched.push({
        name: k.name,
        kaprukaUrl: k.url,
        kaprukaPrice: k.price,
        partnerName: best.p.name,
        partnerUrl: best.p.url,
        partnerSku: best.p.sku,
        partnerBrand: best.p.brand || '',
        partnerCategory: best.p.category || '',
        partnerPrice: best.p.price,
        partnerRegularPrice: best.p.regularPrice,
        confidence: best.sc.codes >= 1 && best.sc.jaccard >= HIGH_CONFIDENCE_MIN_JACCARD ? 'high' : 'medium',
        sharedCodes: best.sc.codes,
        nameSimilarity: Math.round(best.sc.jaccard * 100),
        ...price,
      });
    }
  }

  const matchedKaprukaUrls = new Set(matched.map((m) => m.kaprukaUrl));
  const onlyKapruka = kIndexed
    .filter((k) => !matchedKaprukaUrls.has(k.url))
    .map((k) => ({ name: k.name, price: k.price, url: k.url }));
  const onlyPartner = pIndexed
    .filter((p) => !usedPartner.has(p.id))
    .map((p) => ({ name: p.name, sku: p.sku, price: p.price, url: p.url, brand: p.brand || '', category: p.category || '' }));

  return { matched, onlyKapruka, onlyPartner };
}
