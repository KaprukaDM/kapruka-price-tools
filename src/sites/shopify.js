// Platform adapter: Shopify.
//
// Shopify exposes a clean JSON endpoint at /products/<handle>.js with every
// variant + price (in cents). This is deterministic and covers ANY Shopify
// store (Divine, Gerard Mendis, many cosmetics shops, etc.) — no HTML parsing.

import { normalizeStorage } from '../variant.js';

const PAGE_TIMEOUT_MS = 15000;
const H = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'si-LK,en-LK', Accept: 'application/json' };

async function fetchJson(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), PAGE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: H, redirect: 'follow', signal: c.signal });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    const body = await r.text();
    if (!/json/i.test(ct) && !body.trim().startsWith('{')) return null;
    return JSON.parse(body);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Build the .js endpoint from a product URL (handles /products/<handle> with
// optional /collections/... prefix and query strings).
function shopifyJsUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = u.pathname.match(/\/products\/([^/]+)/);
  if (!m) return null;
  return `${u.origin}/products/${m[1]}.js`;
}

/**
 * Try to scrape `url` as a Shopify product. Returns the standard result shape,
 * or null if it isn't a Shopify product page.
 */
export async function scrapeShopify(url, opts = {}) {
  const jsUrl = shopifyJsUrl(url);
  if (!jsUrl) return null;
  const data = await fetchJson(jsUrl);
  if (!data || !Array.isArray(data.variants) || data.variants.length === 0) return null;

  const requested = normalizeStorage(opts.storage);
  const variants = data.variants
    .map((v) => ({
      label: (v.public_title || v.title || '').trim() || 'Default',
      price: typeof v.price === 'number' ? v.price / 100 : parseFloat(v.price) / 100,
      available: v.available !== false,
    }))
    .filter((v) => Number.isFinite(v.price) && v.price > 0);

  if (variants.length === 0) return null;

  const variantPrices = {};
  for (const v of variants) variantPrices[v.label] = v.price;
  const availableStorages = variants.map((v) => v.label);

  // Pick price: requested variant if it matches a label, else cheapest available.
  let price = null;
  let priceContext = '';
  let flags = [];
  if (requested) {
    const hit = variants.find((v) => normalizeStorage(v.label) === requested);
    if (hit) {
      price = hit.price;
      priceContext = hit.label;
    } else {
      flags.push('variant_unavailable');
      priceContext = `${requested} not offered. Variants: ${availableStorages.join(', ')}`;
    }
  } else {
    const avail = variants.filter((v) => v.available);
    const pick = (avail.length ? avail : variants).reduce((a, b) => (b.price < a.price ? b : a));
    price = pick.price;
    priceContext = variants.length > 1 ? `${pick.label} (cheapest of ${variants.length} variants)` : pick.label;
  }

  return {
    platform: 'shopify',
    url,
    title: data.title || null,
    image: data.featured_image ? `https:${String(data.featured_image).replace(/^https?:/, '')}` : null,
    currency: 'LKR', // SL Shopify stores; .js carries no currency code
    requestedStorage: requested,
    availableStorages,
    variantPrices,
    price,
    priceContext,
    flags,
  };
}
