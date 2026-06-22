// SERP layer: given a product name and a site domain, return a few candidate
// product-page URLs on that domain. Provider is abstracted so swapping
// Serper / SerpAPI / ScrapingBee is a one-place change.

const SERP_API_KEY = process.env.SERP_API_KEY || '';

// Resolve provider: explicit env wins; "auto" detects from key shape
// (SerpApi.com keys are 64-char hex; Serper.dev keys are 40-char hex).
function resolveProvider() {
  const p = (process.env.SERP_PROVIDER || 'auto').toLowerCase();
  if (p === 'serpapi' || p === 'serper') return p;
  return /^[0-9a-f]{64}$/i.test(SERP_API_KEY) ? 'serpapi' : 'serper';
}
const SERP_PROVIDER = resolveProvider();

// Clean a product name before sending it to the search engine. Parenthetical
// notes and stray punctuation (e.g. "Chocolate Cake(gmc)") can zero out results,
// so we strip them for the SEARCH only — the full name is still used for matching.
function cleanQuery(s) {
  return String(s || '')
    .replace(/\([^)]*\)/g, ' ') // remove "(gmc)" etc.
    .replace(/[^\w\s.\-+&]/g, ' ') // drop odd punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// How many candidate URLs to consider per site.
const MAX_CANDIDATES = 4;

// --- Providers -------------------------------------------------------------
// Each provider returns an array of organic result URLs (strings) for the query.

async function serper(query) {
  // https://serper.dev — POST JSON, returns { organic: [{ link, title, ... }] }
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': SERP_API_KEY,
      'Content-Type': 'application/json',
    },
    // gl=lk / hl biases results toward Sri Lanka.
    body: JSON.stringify({ q: query, gl: 'lk', hl: 'en', num: 10 }),
  });
  if (!res.ok) {
    throw new Error(`Serper error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.organic || []).map((r) => r.link).filter(Boolean);
}

async function serpapi(query) {
  // https://serpapi.com — GET, returns { organic_results: [{ link, ... }] }
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('q', query);
  url.searchParams.set('gl', 'lk');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('num', '10');
  url.searchParams.set('api_key', SERP_API_KEY);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SerpApi error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return (data.organic_results || []).map((r) => r.link).filter(Boolean);
}

const PROVIDERS = { serper, serpapi };

// --- Public API ------------------------------------------------------------

/**
 * Return up to MAX_CANDIDATES product-page URLs for `productName` on `domain`.
 * Filtered to the requested domain so we only scrape that site's own pages.
 */
export async function getCandidateUrls(productName, domain) {
  const provider = PROVIDERS[SERP_PROVIDER];
  if (!provider) {
    throw new Error(
      `Unknown SERP_PROVIDER "${SERP_PROVIDER}". Supported: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  if (!SERP_API_KEY) {
    throw new Error('SERP_API_KEY is not set');
  }

  const query = `${cleanQuery(productName)} site:${domain}`;
  let urls = [];
  try {
    urls = await provider(query);
  } catch (err) {
    // Surface as empty + reason; pipeline turns this into a per-site flag.
    return { urls: [], error: err.message };
  }

  // Keep only on-domain, single-product URLs; drop homepages and listing pages.
  const seen = new Set();
  const filtered = [];
  for (const u of urls) {
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      continue;
    }
    const host = parsed.hostname.replace(/^www\./, '');
    if (!host.endsWith(domain)) continue;
    if (!isLikelyProductUrl(parsed)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    filtered.push(u);
    if (filtered.length >= MAX_CANDIDATES) break;
  }

  return { urls: filtered, error: null };
}

// Domains/markers excluded from discovery (marketplaces, classifieds, social,
// and obvious foreign retailers). Sri Lankan sites are kept via the .lk check.
const DISCOVERY_BLOCKLIST = [
  'daraz.', // Daraz
  'ikman.', // classifieds
  'facebook.', 'fb.com', 'fb.me', 'instagram.', 'tiktok.', 'pinterest.', // social
  'bigdeal', 'big-deal', // Big Deals
  'amazon.', 'ebay.', 'aliexpress.', 'alibaba.', 'walmart.', // foreign marketplaces
  'google.', 'youtube.', 'wikipedia.', // non-retail
  // Review / blog / news / price-aggregator sites (not shops)
  'smartzone.', 'gsmarena.', 'reddit.', 'quora.', 'medium.',
  'blogspot.', 'wordpress.com', 'pricena', 'pricelanka', 'pricelist',
];

// Path markers that indicate an article/review/blog page rather than a product.
const EDITORIAL_PATH_MARKERS = ['/review', '/reviews', '/blog', '/news', '/article', '/articles'];

/**
 * Discovery search: find the top distinct Sri Lankan retail sites selling the
 * product, from a general (non site-restricted) search. Excludes the blocklist
 * and any domains in `excludeDomains` (e.g. already-curated category sites).
 * Returns up to `limit` { domain, url } pairs, one per site.
 */
export async function getShoppingCandidates(productName, excludeDomains = [], limit = 5) {
  const provider = PROVIDERS[SERP_PROVIDER];
  if (!provider || !SERP_API_KEY) return { sites: [], error: 'SERP not configured' };

  const exclude = new Set(excludeDomains.map((d) => d.replace(/^www\./, '')));
  let urls = [];
  try {
    urls = await provider(`${cleanQuery(productName)} price Sri Lanka`);
  } catch (err) {
    return { sites: [], error: err.message };
  }

  const seenDomains = new Set();
  const sites = [];
  for (const u of urls) {
    let parsed;
    try {
      parsed = new URL(u);
    } catch {
      continue;
    }
    const host = parsed.hostname.replace(/^www\./, '');
    // Sri Lankan only (drops foreign sites and facebook.com etc.).
    if (!host.endsWith('.lk')) continue;
    if (DISCOVERY_BLOCKLIST.some((b) => host.includes(b))) continue;
    if (exclude.has(host)) continue;
    if (!isLikelyProductUrl(parsed)) continue;
    if (seenDomains.has(host)) continue; // one result per site
    seenDomains.add(host);
    sites.push({ domain: host, url: u });
    if (sites.length >= limit) break;
  }
  return { sites, error: null };
}

// Heuristic: is this a specific product page (not a homepage, category, tag,
// search, or brand-archive listing)? Listing pages cause wrong-price matches.
function isLikelyProductUrl(parsed) {
  const path = parsed.pathname.replace(/\/+$/, ''); // strip trailing slash
  if (path === '' || path === '/') return false; // homepage
  // Search results / query-driven listings.
  if (parsed.search && /[?&](q|s|search|keyword)=/i.test(parsed.search)) return false;
  const lower = path.toLowerCase();
  // Archive/listing path markers anywhere in the path (WooCommerce, Shopify, etc.).
  const listingMarkers = [
    '/product-tag/',
    '/product-category/',
    '/category/',
    '/categories/',
    '/collections/', // Shopify collection listing (single products are /products/)
    '/aisle/', '/aisles/', // OnlineKade etc. category aisles
    '/tag/',
    '/brand/',
    '/brands/',
  ];
  if (listingMarkers.some((m) => lower.includes(m))) return false;
  // Editorial/review/blog/news pages are not product pages.
  if (EDITORIAL_PATH_MARKERS.some((m) => lower.includes(m))) return false;
  // Bare listing roots only (don't reject /shop/<product> or /search-... products).
  if (['/shop', '/store', '/search', '/products', '/product'].includes(lower)) return false;
  return true;
}
