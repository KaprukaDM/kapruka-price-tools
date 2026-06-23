// Orchestration: for a category + product query, run serp -> scrape -> match
// for every configured site, and return one best result per site.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getCandidateUrls, getShoppingCandidates } from './serp.js';
import { scrapeProduct } from './scrape.js';
import { scoreMatch, scoreIdentity } from './matcher.js';
import { getSiteScraper, scrapeByPlatform } from './sites/index.js';
import { parseStorage } from './variant.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATEGORIES_PATH = join(__dirname, '..', 'config', 'categories.json');

// Below this match rate we don't trust the result as "the same product".
const MATCH_THRESHOLD = 50;

// Categories with no exact model/variant — match on product name only.
const NAME_ONLY_CATEGORIES = new Set(['Cakes']);

export async function loadCategories() {
  const raw = await readFile(CATEGORIES_PATH, 'utf-8');
  return JSON.parse(raw);
}

// Process a single site end-to-end. Always resolves (never rejects) so one bad
// site can't sink the whole request.
async function processSite(query, site) {
  const base = { site: site.name, domain: site.domain };
  const requestedStorage = parseStorage(`${query.name} ${query.description || ''}`);
  const siteScraper = getSiteScraper(site.domain);

  // 1) candidate URLs from SERP
  const { urls, error: serpError } = await getCandidateUrls(query.name, site.domain);
  if (serpError) {
    return { ...base, status: 'error', flags: ['serp_failed'], note: serpError };
  }
  if (urls.length === 0) {
    return { ...base, status: 'no_result', flags: ['no_candidates'] };
  }

  // 2/3) build candidates, keep the best by match rate.
  // Per-site scrapers drive a real browser (slow), so try only the top result,
  // then fall through to the next only if identity is weak. Generic tries 2.
  const cap = siteScraper ? 2 : 2;
  let best = null;
  for (const url of urls.slice(0, cap)) {
    const candidate = siteScraper
      ? await buildFromSiteScraper(query, site, url, requestedStorage, siteScraper)
      : await buildSmart(query, site, url, requestedStorage);
    if (!best || candidate.matchRate > best.matchRate) best = candidate;
    if (best.matchRate >= 80) break; // good enough; stop early
  }

  best.status = deriveStatus(best);
  best.requestedStorage = requestedStorage;
  return best;
}

// Per-domain scraper path.
async function buildFromSiteScraper(query, site, url, requestedStorage, siteScraper) {
  const data = await siteScraper(url, { storage: requestedStorage });
  return finalizeSiteData(query, site, url, requestedStorage, data);
}

// Platform path: try Shopify/Woo adapters; fall back to the generic scraper.
async function buildSmart(query, site, url, requestedStorage) {
  const data = await scrapeByPlatform(url, { storage: requestedStorage });
  if (data) return finalizeSiteData(query, site, url, requestedStorage, data);
  return buildFromGeneric(query, site, url);
}

// Shared: turn deterministic scraper/adapter data + an identity check into a result.
// Identity match rate is a confidence signal only — we still show any price found.
async function finalizeSiteData(query, site, url, requestedStorage, data) {
  const identity = await scoreIdentity(query, {
    title: data.title,
    url: data.url || url,
    site: site.name,
  });
  const matchRate = Number.isFinite(identity.matchRate) ? identity.matchRate : 0;

  const flags = [...(data.flags || [])];
  let price = data.price ?? null;
  let priceContext = data.priceContext || '';

  // Always surface a price if we have one. If the requested variant is missing
  // but other variants exist, show the cheapest and say so (don't blank it).
  if (price == null && data.variantPrices && Object.keys(data.variantPrices).length) {
    const entries = Object.entries(data.variantPrices);
    const [label, cheapest] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
    price = cheapest;
    if (!priceContext) priceContext = `showing ${label} (requested variant not listed)`;
  }
  if (identity.error) flags.push('match_failed');

  return {
    ...base(site),
    title: data.title,
    url: data.url || url,
    image: data.image || null,
    matchRate,
    price,
    currency: data.currency || 'LKR',
    priceContext,
    reasoning: identity.reasoning || '',
    availableStorages: data.availableStorages || [],
    variantPrices: data.variantPrices || {},
    flags,
  };
}

// Generic fallback path (sites without a custom scraper).
async function buildFromGeneric(query, site, url) {
  const scraped = await scrapeProduct(url);
  const match = await scoreMatch(query, scraped);
  const matchRate = Number.isFinite(match.matchRate) ? match.matchRate : 0;
  const flags = [...scraped.flags];
  if (match.error) flags.push('match_failed');
  let price = match.chosenPriceValue ?? null;
  // Always show a price if the page had one: fall back to the highest scraped
  // price (full price usually exceeds installment/deposit amounts), flagged.
  if (price == null && Array.isArray(scraped.prices) && scraped.prices.length) {
    price = Math.max(...scraped.prices.map((p) => p.value));
    flags.push('price_approx');
  }
  if (price == null && !flags.includes('price_not_found')) flags.push('price_not_found');
  return {
    ...base(site),
    title: scraped.title,
    url: scraped.url,
    image: scraped.image,
    matchRate,
    price,
    currency: match.chosenPriceCurrency ?? scraped.currency ?? null,
    priceContext: match.priceContext || '',
    reasoning: match.reasoning || '',
    flags,
  };
}

function base(site) {
  return { site: site.name, domain: site.domain };
}

function prettyName(domain) {
  const core = domain.replace(/^www\./, '').split('.')[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

// Build a result for a discovered web URL (we already have the URL, skip SERP).
async function processDiscovered(query, requestedStorage, { domain, url }) {
  const site = { name: prettyName(domain), domain };
  const scraper = getSiteScraper(domain);
  const c = scraper
    ? await buildFromSiteScraper(query, site, url, requestedStorage, scraper)
    : await buildSmart(query, site, url, requestedStorage);
  c.status = deriveStatus(c);
  c.source = 'web';
  return c;
}

function fmtLkr(v) {
  return v == null ? '—' : `Rs.${Number(v).toLocaleString('en-LK')}`;
}

function deriveStatus(c) {
  if (c.matchRate < MATCH_THRESHOLD) return 'low_confidence';
  if (c.flags.includes('variant_unavailable')) return 'variant_unavailable';
  if (c.flags.includes('currency_mismatch')) return 'currency_mismatch';
  if (c.price == null || c.flags.includes('price_not_found')) return 'price_not_found';
  return 'ok';
}

/**
 * Run the full match for a category.
 * @param {string} category
 * @param {{name: string, description: string}} query
 * @returns {Promise<{category, query, results: object[]}>}
 */
/**
 * @param {string} category
 * @param {{name,description}} query
 * @param {(ev: object) => void} [onProgress] called as each site resolves, so a
 *   caller (e.g. an SSE endpoint) can stream live progress to the browser.
 */
export async function runMatch(category, query, onProgress = () => {}) {
  const categories = await loadCategories();
  const sites = categories[category];
  if (!sites) {
    throw new Error(`Unknown category: ${category}`);
  }
  // Some categories (e.g. Cakes) have no exact model/variant — match on the
  // product name only, ignoring the description, so matching isn't over-strict.
  const matchQuery = NAME_ONLY_CATEGORIES.has(category)
    ? { name: query.name, description: '' }
    : query;
  const requestedStorage = parseStorage(`${matchQuery.name} ${matchQuery.description || ''}`);

  onProgress({ type: 'start', curatedTotal: sites.length });
  let curatedDone = 0;
  let discoveredDone = 0;

  // 1) Curated category sites (custom scrapers where available).
  const curatedPromise = Promise.all(
    sites.map((site) =>
      processSite(matchQuery, site)
        .then((r) => ({ ...r, source: 'curated' }))
        .then((r) => {
          onProgress({ type: 'site', phase: 'curated', label: site.name, done: ++curatedDone, total: sites.length, result: r });
          return r;
        }),
    ),
  );

  // 2) Discovery: top Sri Lankan shops from a general web search (excluding the
  //    curated domains we already cover + the blocklist).
  const discoveredPromise = getShoppingCandidates(
    matchQuery.name,
    sites.map((s) => s.domain),
  ).then(({ sites: shops }) => {
    onProgress({ type: 'discoveredTotal', count: shops.length });
    return Promise.all(
      shops.map((s) =>
        processDiscovered(matchQuery, requestedStorage, s).then((r) => {
          onProgress({ type: 'site', phase: 'discovered', label: r.site || r.domain, done: ++discoveredDone, total: shops.length, result: r });
          return r;
        }),
      ),
    );
  });

  const [results, discovered] = await Promise.all([curatedPromise, discoveredPromise]);

  results.sort(byBestValue);
  discovered.sort(byBestValue);

  return { category, query, results, discovered };
}

// Usable results first (by match rate, then cheapest), flagged last.
function byBestValue(a, b) {
  const aOk = a.status === 'ok' ? 0 : 1;
  const bOk = b.status === 'ok' ? 0 : 1;
  if (aOk !== bOk) return aOk - bOk;
  if ((b.matchRate || 0) !== (a.matchRate || 0)) return (b.matchRate || 0) - (a.matchRate || 0);
  return (a.price ?? Infinity) - (b.price ?? Infinity);
}
