// Auto-matches each Kapruka UAE product to its fnp.ae counterpart by name.
// Kapruka's UAE hampers are largely re-listed fnp.ae products under the same
// name (e.g. "Happy Birthday Celebration Hamper" appears verbatim on both
// sites), so normalized-token overlap is a reliable, cheap match — no AI call
// needed. Reuses the same tokenizer as src/compare/matcher.js.

import { tokenize, normalizeName } from '../compare/normalize.js';

const MIN_JACCARD = 0.5;

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// For each Kapruka product, find the best-scoring fnp.ae candidate.
// Returns a Map<sku, { fnpUrl, fnpName, confidence, score }>.
export function autoMatch(kaprukaProducts, fnpCatalog) {
  const indexed = fnpCatalog.map((p) => ({ ...p, _tokens: tokenize(p.name), _norm: normalizeName(p.name) }));
  const results = new Map();

  for (const k of kaprukaProducts) {
    const kNorm = normalizeName(k.name);
    const kTokens = tokenize(k.name);

    // Exact normalized-name match wins outright.
    const exact = indexed.find((p) => p._norm === kNorm);
    if (exact) {
      results.set(k.sku, { fnpUrl: exact.url, fnpName: exact.name, confidence: 'exact', score: 1 });
      continue;
    }

    let best = null;
    for (const p of indexed) {
      const score = jaccard(kTokens, p._tokens);
      if (score >= MIN_JACCARD && (!best || score > best.score)) best = { p, score };
    }
    if (best) {
      results.set(k.sku, {
        fnpUrl: best.p.url,
        fnpName: best.p.name,
        confidence: best.score >= 0.8 ? 'high' : 'medium',
        score: best.score,
      });
    }
  }

  return results;
}
