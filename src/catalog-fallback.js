// Live "browse the catalogue directly" fallback for the Price Checker
// (pipeline.js), used when a site's SERP-based candidate search fails or
// finds nothing -- the `site:` search operator is unreliable/blocked for
// some domains (see electronics-audit/site-adapters.js), which used to mean
// those sites just came back "no result" even when the product genuinely
// exists there.
//
// If we already know how to read this site's full product catalogue --
// either a bespoke adapter from one of the category-audit systems, or a
// generic WooCommerce/Shopify auto-detect -- fetch it and pick whichever
// product's name is the closest match to the query, using the same
// identity-scoring logic the audit systems already use for exactly this
// (index() + scoreCandidate()).

import { index } from './compare/matcher.js';
import { scoreCandidate } from './compare/audit-scoring.js';
import { fetchPartnerCatalog } from './compare/sources.js';
import { CATALOG_ADAPTERS as CHOCOLATES_ADAPTERS } from './chocolates-audit/site-adapters.js';
import { CATALOG_ADAPTERS as COSMETICS_ADAPTERS } from './cosmetics-audit/site-adapters.js';
import { CATALOG_ADAPTERS as ELECTRONICS_ADAPTERS } from './electronics-audit/site-adapters.js';
import { CATALOG_ADAPTERS as HOME_LIFESTYLE_ADAPTERS } from './home-lifestyle-audit/site-adapters.js';
import { CATALOG_ADAPTERS as SPORTS_ADAPTERS } from './sports-audit/site-adapters.js';

const ADAPTER_BY_DOMAIN = new Map();
for (const list of [
  CHOCOLATES_ADAPTERS, COSMETICS_ADAPTERS, ELECTRONICS_ADAPTERS, HOME_LIFESTYLE_ADAPTERS, SPORTS_ADAPTERS,
]) {
  for (const a of list) if (!ADAPTER_BY_DOMAIN.has(a.domain)) ADAPTER_BY_DOMAIN.set(a.domain, a);
}

// Catalogues don't change hour to hour (same assumption crawl-catalogs.js
// makes), and a checker session can easily re-query the same site for
// several different products in a row -- cache per domain so that doesn't
// mean re-crawling a large catalogue (e.g. Nanotek's 28 categories) on
// every single query.
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // domain -> { at, products }
const FETCH_FAILED = null; // distinguishes "tried, got nothing" from "never tried" in the cache

async function fetchCatalogForDomain(domain) {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.products;

  let products = FETCH_FAILED;
  const adapter = ADAPTER_BY_DOMAIN.get(domain);
  if (adapter) {
    try {
      const raw = await adapter.fetchCatalog();
      products = raw.map((p) => ({ name: p.name, url: p.url, price: p.priceLKR ?? null }));
    } catch {
      products = FETCH_FAILED;
    }
  }
  if (!products) {
    try {
      const r = await fetchPartnerCatalog(domain, { platform: 'auto' });
      products = r.products.map((p) => ({ name: p.name, url: p.url, price: p.price ?? null }));
    } catch {
      products = FETCH_FAILED;
    }
  }
  cache.set(domain, { at: Date.now(), products });
  return products;
}

function toIndexed(name) {
  const [row] = index([{ name, url: 'query' }], false);
  return row;
}

// Returns a pipeline-shaped result (missing `status`, same convention as
// finalizeSiteData -- the caller derives it), or null if no catalogue could
// be read or nothing in it scored as a plausible match.
export async function tryCatalogFallback(query, site) {
  const products = await fetchCatalogForDomain(site.domain);
  if (!products || !products.length) return null;

  const qIndexed = toIndexed(query.name);
  const indexed = index(products, false);
  let best = null;
  for (const c of indexed) {
    const sc = scoreCandidate(qIndexed, c);
    if (sc && (!best || sc.value > best.sc.value)) best = { c, sc };
  }
  if (!best) return null;

  return {
    site: site.name,
    domain: site.domain,
    title: best.c.name,
    url: best.c.url,
    image: null,
    matchRate: Math.round(best.sc.overlap * 100),
    price: best.c.price ?? null,
    currency: 'LKR',
    priceContext: '',
    reasoning: "Matched from the site's own catalogue listing (product search was unavailable for this site).",
    availableStorages: [],
    variantPrices: {},
    flags: ['catalog_fallback'],
  };
}
