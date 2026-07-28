// Core comparison engine for the International Gifting Price Checker — pulled
// out of routes.js so it can be run two ways with identical behavior:
//   1. On-demand from the Express route (src/uae-compare/routes.js), for
//      local dev / the standalone server (`npm run uae-compare`).
//   2. From a plain Node script (scripts/refresh-intl-gifts.js), for the
//      GitHub Actions workflow that powers the static (GitHub Pages)
//      dashboard — see public/uae-compare/index.html.
//
// Compares Kapruka's international gifts catalog for a given country
// (kapruka.com/online/<country>, LKR) against the matching product on that
// country's competitor site (see countries.js), converted at the live market
// FX rate. UAE (fnp.ae) is the only country wired up today; see countries.js
// for how to add more.
//
// Once a Kapruka product is matched to a competitor URL — auto-matched by
// name or manually confirmed — that pairing is cached in the database
// (src/db.js) and reused on every future refresh. The competitor's catalog is
// still crawled every refresh (it's the reliable price source for most
// categories), but name-matching only runs for products with no cached
// pairing yet, so that work only shrinks over time. Paired products whose URL
// isn't present in a given crawl (e.g. fnp.ae's /cakes category renders a
// different random subsample of products on every request — see
// fnp-scraper.js) fall back to a direct per-page fetch instead.
//
// Every run also writes the full result to intl_gift_snapshots (src/db.js),
// which is what the static dashboard actually reads.

import { fetchKaprukaCountryCatalog } from './kapruka-scraper.js';
import { autoMatch } from './matcher.js';
import { getAedToLkrRate } from './fx.js';
import { loadPairings, setPairing } from './pairings-store.js';
import { getCountry } from './countries.js';
import { setIntlGiftSnapshot } from '../db.js';

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

function toRow(k, fnpUrl, matchSource, matchConfidence, competitor, fxRate) {
  let priceLKR = null;
  let diffLKR = null;
  let diffPct = null;
  if (competitor?.priceAED != null && fxRate) {
    priceLKR = competitor.priceAED * fxRate;
    diffLKR = k.priceLKR - priceLKR;
    diffPct = (diffLKR / priceLKR) * 100;
  }
  let status = 'unpaired';
  if (fnpUrl) status = competitor?.priceAED != null ? 'ok' : 'scrape_failed';

  return {
    sku: k.sku,
    kaprukaName: k.name,
    kaprukaUrl: k.url,
    kaprukaImage: k.image,
    kaprukaPriceLKR: k.priceLKR,
    fnpUrl,
    fnpName: competitor?.name || null,
    fnpImage: competitor?.image || null,
    fnpPriceAED: competitor?.priceAED ?? null,
    fnpPriceLKR: priceLKR,
    diffLKR,
    diffPct,
    matchSource,
    matchConfidence,
    status,
  };
}

// Re-scrapes both sides, recomputes the comparison, persists any newly
// auto-matched pairings, and saves the result as the latest snapshot for
// this country. Returns the same result it saves.
export async function runComparison(countryCode, { forceFx = false } = {}) {
  const country = getCountry(countryCode);

  const [kaprukaProducts, pairings, fx, competitorCatalog] = await Promise.all([
    fetchKaprukaCountryCatalog(countryCode),
    loadPairings(countryCode),
    getAedToLkrRate({ force: forceFx }),
    country.fetchCatalog(),
  ]);

  const competitorByUrl = new Map(competitorCatalog.map((p) => [p.url, p]));

  const unpaired = kaprukaProducts.filter((k) => !pairings[k.sku]?.fnpUrl);
  const newAutoMatches = unpaired.length ? autoMatch(unpaired, competitorCatalog) : new Map();

  // Cache whatever the auto-matcher found so future refreshes don't need to
  // re-match these — self-populating over time.
  await Promise.all(
    [...newAutoMatches.entries()].map(([sku, m]) => setPairing(countryCode, sku, m.fnpUrl, 'auto', m.confidence)),
  );

  // Paired products whose URL isn't in this round's crawl (e.g. cakes/
  // chocolates, whose category page only shows a rotating subsample) get a
  // direct per-page fetch instead — the fallback path that actually is
  // reliable for that case.
  const pairedUrlsNeedingDirectFetch = kaprukaProducts
    .map((k) => pairings[k.sku]?.fnpUrl)
    .filter((url) => url && !competitorByUrl.has(url));
  await mapWithConcurrency([...new Set(pairedUrlsNeedingDirectFetch)], 5, async (url) => {
    try {
      competitorByUrl.set(url, await country.fetchProduct(url));
    } catch (err) {
      competitorByUrl.set(url, { name: null, priceAED: null, error: err.message });
    }
  });

  const comparisons = kaprukaProducts.map((k) => {
    const existing = pairings[k.sku];
    if (existing?.fnpUrl) {
      return toRow(k, existing.fnpUrl, existing.matchSource, existing.matchConfidence, competitorByUrl.get(existing.fnpUrl), fx.rate);
    }
    const auto = newAutoMatches.get(k.sku);
    if (auto) {
      return toRow(k, auto.fnpUrl, 'auto', auto.confidence, competitorByUrl.get(auto.fnpUrl), fx.rate);
    }
    return toRow(k, null, null, null, null, fx.rate);
  });

  const pairedCount = comparisons.filter((c) => c.status !== 'unpaired').length;

  const result = {
    country: countryCode,
    competitorName: country.competitorName,
    fx: { aedToLkr: fx.rate, asOf: fx.asOf },
    kaprukaCount: kaprukaProducts.length,
    pairedCount,
    comparisons,
    generatedAt: new Date().toISOString(),
  };

  await setIntlGiftSnapshot(countryCode, result);
  return result;
}
