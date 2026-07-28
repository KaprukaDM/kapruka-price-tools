// API router for the FNP.ae vs Kapruka UAE price dashboard. Exported so it can
// be mounted either by the standalone server (src/uae-compare/server.js,
// `npm run uae-compare`) or embedded directly into the main Price Tools hub
// (src/server.js) at /api/uae-compare/* — same routes, same behavior, just
// sharing the hub's existing process instead of running as a separate service.
//
// Compares Kapruka's UAE gifts catalog (kapruka.com/online/UAE, LKR) against
// the matching product on fnp.ae (AED), converted at the live AED->LKR rate.
//
// Both catalogs are auto-scraped every refresh. fnp.ae has no public search
// API, so matches are found by crawling its category pages and comparing
// normalized product names (see matcher.js) — most Kapruka UAE hampers are
// re-listed fnp.ae products under the same name, so this is high-confidence.
// A dashboard row can still be manually re-paired (config/uae-pairings.json)
// when the auto-match misses or picks the wrong product; manual pairings
// always win over the auto-match.

import express from 'express';

import { fetchKaprukaUaeCatalog } from './kapruka-scraper.js';
import { fetchFnpCatalog, fetchFnpProduct } from './fnp-scraper.js';
import { autoMatch } from './matcher.js';
import { getAedToLkrRate } from './fx.js';
import { loadPairings, setPairing } from './pairings-store.js';

// Run `tasks` (thunks) with at most `limit` in flight at once.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function buildComparison(kaprukaProducts, pairings, autoMatches, fnpByUrl, fnpResults, fxRate) {
  return kaprukaProducts.map((k) => {
    const manualUrl = pairings[k.sku] || null;
    const auto = autoMatches.get(k.sku) || null;
    const fnpUrl = manualUrl || auto?.fnpUrl || null;
    const matchSource = manualUrl ? 'manual' : auto ? 'auto' : null;
    const matchConfidence = manualUrl ? null : auto?.confidence || null;

    // Prefer the price already captured while crawling fnp.ae's category
    // pages; only a manually-pasted URL outside those categories needs a
    // dedicated per-page scrape (see fnpResults).
    const fnp = fnpUrl ? fnpByUrl.get(fnpUrl) || fnpResults.get(fnpUrl) : null;

    let fnpPriceLKR = null;
    let diffLKR = null;
    let diffPct = null;
    if (fnp?.priceAED != null && fxRate) {
      fnpPriceLKR = fnp.priceAED * fxRate;
      diffLKR = k.priceLKR - fnpPriceLKR;
      diffPct = (diffLKR / fnpPriceLKR) * 100;
    }

    let status = 'unpaired';
    if (fnpUrl) status = fnp?.priceAED != null ? 'ok' : 'scrape_failed';

    return {
      sku: k.sku,
      kaprukaName: k.name,
      kaprukaUrl: k.url,
      kaprukaImage: k.image,
      kaprukaPriceLKR: k.priceLKR,
      fnpUrl,
      fnpName: fnp?.name || null,
      fnpImage: fnp?.image || null,
      fnpPriceAED: fnp?.priceAED ?? null,
      fnpPriceLKR,
      diffLKR,
      diffPct,
      matchSource,
      matchConfidence,
      status,
    };
  });
}

async function runComparison({ forceFx = false } = {}) {
  const [kaprukaProducts, fnpCatalog, pairings, fx] = await Promise.all([
    fetchKaprukaUaeCatalog(),
    fetchFnpCatalog(),
    loadPairings(),
    getAedToLkrRate({ force: forceFx }),
  ]);

  const fnpByUrl = new Map(fnpCatalog.map((p) => [p.url, p]));
  const autoMatches = autoMatch(kaprukaProducts, fnpCatalog);

  // Manual pairings that point at a URL NOT already in the crawled catalog
  // (e.g. pasted from a category we don't crawl) need a live per-page scrape.
  const manualUrlsNeedingScrape = [
    ...new Set(Object.values(pairings).filter((url) => url && !fnpByUrl.has(url))),
  ];
  const fnpResults = new Map();
  await mapWithConcurrency(manualUrlsNeedingScrape, 5, async (url) => {
    try {
      fnpResults.set(url, await fetchFnpProduct(url));
    } catch (err) {
      fnpResults.set(url, { name: null, priceAED: null, error: err.message });
    }
  });

  const comparisons = buildComparison(kaprukaProducts, pairings, autoMatches, fnpByUrl, fnpResults, fx.rate);
  const pairedCount = comparisons.filter((c) => c.status !== 'unpaired').length;

  return {
    fx: { aedToLkr: fx.rate, asOf: fx.asOf },
    kaprukaCount: kaprukaProducts.length,
    fnpCatalogCount: fnpCatalog.length,
    pairedCount,
    comparisons,
    generatedAt: new Date().toISOString(),
  };
}

// Returns an Express Router with the /api/uae-compare/* routes. The caller is
// responsible for express.json() (so it isn't applied twice when embedded in
// a host app that already parses JSON globally).
export function uaeCompareApiRouter() {
  const router = express.Router();

  // Full refresh: re-scrape Kapruka's UAE catalog, re-scrape every paired
  // fnp.ae product, and fetch a fresh FX rate.
  router.post('/api/uae-compare/refresh', async (_req, res) => {
    try {
      res.json(await runComparison({ forceFx: true }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/uae-compare/pairings', async (_req, res) => {
    res.json(await loadPairings());
  });

  router.post('/api/uae-compare/pairings', async (req, res) => {
    const { sku, fnpUrl } = req.body || {};
    if (!sku) return res.status(400).json({ error: 'sku is required' });
    if (fnpUrl && !/^https?:\/\/(www\.)?fnp\.ae\//i.test(fnpUrl)) {
      return res.status(400).json({ error: 'fnpUrl must be an fnp.ae product link' });
    }
    const pairings = await setPairing(sku, fnpUrl || null);
    res.json(pairings);
  });

  return router;
}
