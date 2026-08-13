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
export const SPEC_LESS_MIN_INTERSECTION = 4;

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
]);
function unmatchedDistinctiveToken(kTokens, cTokens) {
  for (const t of kTokens) {
    if (COLOR_WORDS.has(t) || SPEC_TOKEN.test(t)) continue;
    if (!cTokens.has(t)) return t;
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
  'strap', 'bumper', 'magsafe', 'lanyard',
]);
export function accessoryMismatch(kTokens, cTokens) {
  for (const w of ACCESSORY_WORDS) {
    if (cTokens.has(w) && !kTokens.has(w)) return true;
  }
  return false;
}

// k/c are indexed products (see matcher.js's index()) with ._tokens,
// ._codes, ._specs already computed. Returns null (reject) or
// { value, codes, overlap } for ranking candidates against one Kapruka
// product — the highest `value` wins.
export function scoreCandidate(k, c) {
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
    if (unmatchedDistinctiveToken(k._tokens, c._tokens)) return null;
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
  return { value: 1 + overlap + versionBonus, codes, overlap };
}
