// Catalogue fetchers for the two sites being reconciled, parameterised by
// partner so the same code works for any Kapruka partner (see config/partners.json).
//
//   Kapruka (our listing):  server-rendered partner page. Pages are loaded via
//     the same endpoint the "View more" button hits:
//     /srilanka_online_shopping.jsp?partner=<slug>&p=N  — we read each product
//     card from the HTML.
//
//   Partner's own site: platform is auto-detected and the full catalogue pulled
//     from a public endpoint:
//       · WooCommerce -> /wp-json/wc/store/v1/products (Stop N Shop is this)
//       · Shopify     -> /products.json
//     A partner on any other platform needs a bespoke adapter added here.

import * as cheerio from 'cheerio';
import { decodeEntities } from './normalize.js';

// Some product names are mojibake: real UTF-8 punctuation got mis-decoded
// (sometimes twice), leaving clusters like [A-hat|a-hat]+euro+quote. The lead
// char is noise; the trailing char identifies the intended punctuation.
function fixMojibake(s) {
  return s
    .replace(/[Ââ]€“/g, "–") // en dash
    .replace(/[Ââ]€”/g, "—") // em dash
    .replace(/[Ââ]€™/g, "’") // right single quote
    .replace(/[Ââ]€˜/g, "‘") // left single quote
    .replace(/[Ââ]€œ/g, "“") // left double quote
    .replace(/[Ââ]€/g, "”") // right double quote
    .replace(/Â /g, " "); // non-breaking space
}

const UA = { 'User-Agent': 'Mozilla/5.0 (price-reconcile bot)', 'Accept-Language': 'en-LK,en' };

async function fetchText(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 30000);
  try {
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Fetch JSON, returning null on any non-JSON / error response (used for
// platform probing where a 404 just means "not this platform").
async function fetchJsonSafe(url) {
  try {
    const text = await fetchText(url);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Normalise a site URL to its origin (https://host), no trailing slash.
function toOrigin(site) {
  const u = new URL(site.startsWith('http') ? site : `https://${site}`);
  return u.origin;
}

// ---- Kapruka -------------------------------------------------------------

// Kapruka exposes the same product cards through two listing endpoints. We turn
// a pasted Kapruka link into a "source descriptor" so either can drive the tool:
//   · partner storefront   /partner/<slug>
//       -> srilanka_online_shopping.jsp?partner=<slug>
//   · brand/category list  /online/<category>[/price/<brand>]
//       -> srilanka_online_catalogue.jsp?buy=<category>[&subcat=<brand>]
export function parseKaprukaSource(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/\/partner\/([^/?#]+)/i);
  if (m) return { type: 'partner', slug: m[1], label: m[1], link: `https://www.kapruka.com/partner/${m[1]}` };
  m = s.match(/\/online\/([^/?#]+)(?:\/price\/([^/?#]+))?/i);
  if (m) {
    const link = `https://www.kapruka.com/online/${m[1]}${m[2] ? `/price/${m[2]}` : ''}`;
    return { type: 'catalogue', buy: m[1], subcat: m[2] || null, label: m[2] ? `${m[1]} / ${m[2]}` : m[1], link };
  }
  // A bare token (no slashes/spaces) is treated as a partner slug.
  if (!s.includes('/') && !s.includes(' ')) {
    return { type: 'partner', slug: s, label: s, link: `https://www.kapruka.com/partner/${s}` };
  }
  return null;
}

// Read a single Kapruka product page (kapruka.com/buyonline/...) into a source
// descriptor we can drive the price-checker with: the product name, description
// and Kapruka's own price become the query + reference. Kapruka renders a clean
// Product JSON-LD (name/description/brand/category/offers); we fall back to
// og:/meta tags if that's ever missing.
export async function fetchKaprukaProduct(url) {
  if (!/kapruka\.com/i.test(String(url || ''))) {
    throw new Error('Paste a Kapruka product link (kapruka.com/buyonline/...).');
  }
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  let product = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    let json;
    try {
      json = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = Array.isArray(json) ? json : json['@graph'] || [json];
    for (const n of nodes) {
      const ty = n && n['@type'];
      if (ty === 'Product' || (Array.isArray(ty) && ty.includes('Product'))) {
        product = n;
        break;
      }
    }
  });

  const offers = product
    ? Array.isArray(product.offers)
      ? product.offers
      : product.offers
        ? [product.offers]
        : []
    : [];
  const offer = offers.find((o) => o && (o.price ?? o.lowPrice) != null) || offers[0] || null;

  const clean = (s) => fixMojibake(decodeEntities(String(s || ''))).replace(/\s+/g, ' ').trim();

  const name =
    clean(product?.name) ||
    clean($('h1').first().text()) ||
    clean($('meta[property="og:title"]').attr('content')).split('|')[0].trim();

  const description =
    clean(product?.description) || clean($('meta[property="og:description"]').attr('content'));

  const rawPrice =
    offer?.price ??
    offer?.lowPrice ??
    $('meta[property="product:price:amount"]').attr('content') ??
    null;
  const priceNum = rawPrice != null ? parseInt(String(rawPrice).replace(/[^0-9]/g, ''), 10) : NaN;
  const price = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;

  const currency =
    offer?.priceCurrency ||
    $('meta[property="product:price:currency"]').attr('content') ||
    'LKR';

  const image =
    (Array.isArray(product?.image) ? product.image[0] : product?.image) ||
    $('meta[property="og:image"]').attr('content') ||
    null;

  const inStock = offer?.availability ? !/OutOfStock/i.test(offer.availability) : null;

  return {
    name,
    description,
    price,
    currency,
    image,
    inStock,
    category: clean(product?.category) || null,
    brand: clean(typeof product?.brand === 'object' ? product?.brand?.name : product?.brand) || null,
    url,
  };
}

// The catalogue endpoint base for a source (callers append &p=N&onlyCatalogueSection=true).
export function kaprukaBaseUrl(src) {
  if (src.type === 'partner') {
    return `https://www.kapruka.com/srilanka_online_shopping.jsp?partner=${encodeURIComponent(src.slug)}`;
  }
  let u = `https://www.kapruka.com/srilanka_online_catalogue.jsp?buy=${encodeURIComponent(src.buy)}`;
  if (src.subcat) u += `&subcat=${encodeURIComponent(src.subcat)}`;
  return u;
}

// Parse the catalogue cards directly from the HTML. Each product is an anchor to
// /buyonline/... wrapping a .catalogueV2heading (name) and a .catalogueV2converted
// price ("RS.12,490"). We read the DOM rather than the per-card JSON-LD because
// some product names contain characters that make the JSON-LD invalid JSON.
function parseKaprukaPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('a[href*="/buyonline/"]').each((_, el) => {
    const $a = $(el);
    const heading = $a.find('.catalogueV2heading').first();
    if (heading.length === 0) return; // not a product card (e.g. a plain link)
    const name = fixMojibake(decodeEntities(heading.text()).replace(/\s+/g, ' ').trim());
    if (!name) return;
    // Discounted cards show the struck-through original price next to the selling
    // price inside the same element. Drop the line-through original so the two
    // numbers aren't concatenated, then take the first (selling) price.
    const priceEl = $a.find('.catalogueV2converted, .CatalogueV2price').first().clone();
    priceEl.find('[style*="line-through"]').remove();
    const m = priceEl.text().match(/(\d[\d,]*)/);
    const price = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    out.push({ name, price, url: $a.attr('href'), inStock: true });
  });
  return out;
}

// `source` is a descriptor from parseKaprukaSource(), or a raw link/slug string.
export async function fetchKaprukaCatalog(source, { log = () => {} } = {}) {
  const src = typeof source === 'string' ? parseKaprukaSource(source) : source;
  if (!src) throw new Error('Unrecognised Kapruka link/source');
  const base = kaprukaBaseUrl(src);
  const byUrl = new Map();
  for (let p = 1; p <= 50; p++) {
    const html = await fetchText(`${base}&p=${p}&onlyCatalogueSection=true`);
    const items = parseKaprukaPage(html);
    if (items.length === 0) break; // past the last page
    let added = 0;
    for (const it of items) {
      if (!byUrl.has(it.url)) {
        byUrl.set(it.url, it);
        added++;
      }
    }
    log(`  Kapruka page ${p}: ${items.length} cards (${added} new), total ${byUrl.size}`);
    // If a page adds nothing new, pagination has wrapped — stop.
    if (added === 0) break;
  }
  return [...byUrl.values()];
}

// Quick validation probe: how many products are on page 1 of a Kapruka source
// (partner storefront or brand/category listing). One request — used to verify a
// link before saving a new partner.
export async function probeKaprukaSource(input) {
  const src = parseKaprukaSource(input);
  if (!src) return 0;
  const url = `${kaprukaBaseUrl(src)}&p=1&onlyCatalogueSection=true`;
  try {
    const html = await fetchText(url);
    return parseKaprukaPage(html).length;
  } catch {
    return 0;
  }
}

// Detect a partner site's platform with a single tiny request each. Returns
// 'woocommerce' | 'shopify' | null.
export async function detectPartnerPlatform(site) {
  const origin = toOrigin(site);
  const woo = await fetchJsonSafe(`${origin}/wp-json/wc/store/v1/products?per_page=1`);
  if (Array.isArray(woo) && woo.length) return 'woocommerce';
  const shop = await fetchJsonSafe(`${origin}/products.json?limit=1`);
  if (shop && Array.isArray(shop.products) && shop.products.length) return 'shopify';
  return null;
}

// ---- Partner site (auto-detected platform) -------------------------------

function minorUnitDivide(value, minorUnit) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return minorUnit ? n / 10 ** minorUnit : n;
}

// WooCommerce Store API: /wp-json/wc/store/v1/products?per_page=100&page=N.
// Prices are integer strings scaled by currency_minor_unit.
async function fetchWooCatalog(origin, log) {
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const arr = await fetchJsonSafe(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      const pr = p.prices || {};
      out.push({
        id: `woo-${p.id}`,
        name: decodeEntities(p.name || '').trim(),
        sku: p.sku || '',
        // Brand + most-specific category come straight from the Store API response
        // (no extra request). Both are optional taxonomies, so guard for absence.
        brand: decodeEntities(p.brands?.[0]?.name || '').trim(),
        category: decodeEntities(p.categories?.[0]?.name || '').trim(),
        price: minorUnitDivide(pr.price, pr.currency_minor_unit),
        regularPrice: minorUnitDivide(pr.regular_price, pr.currency_minor_unit),
        url: p.permalink,
        inStock: p.is_in_stock !== false,
      });
    }
    log(`  partner (woo) page ${page}: +${arr.length}, total ${out.length}`);
    if (arr.length < 100) break;
  }
  return out;
}

// Shopify: /products.json?limit=250&page=N. Prices are major-unit strings; we
// take the cheapest available variant and its SKU.
async function fetchShopifyCatalog(origin, log) {
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const data = await fetchJsonSafe(`${origin}/products.json?limit=250&page=${page}`);
    const products = data && Array.isArray(data.products) ? data.products : null;
    if (!products || products.length === 0) break;
    for (const p of products) {
      const variants = (p.variants || [])
        .map((v) => ({ price: parseFloat(v.price), sku: v.sku, available: v.available !== false }))
        .filter((v) => Number.isFinite(v.price) && v.price > 0);
      if (variants.length === 0) continue;
      const avail = variants.filter((v) => v.available);
      const pick = (avail.length ? avail : variants).reduce((a, b) => (b.price < a.price ? b : a));
      const regulars = (p.variants || [])
        .map((v) => parseFloat(v.compare_at_price))
        .filter((n) => Number.isFinite(n) && n > 0);
      out.push({
        id: `shopify-${p.id}`,
        name: decodeEntities(p.title || '').trim(),
        sku: pick.sku || '',
        // product_type ~ category; vendor ~ brand (note: vendor is often the store
        // name on Shopify, so treat it as a best-effort brand signal).
        brand: (p.vendor || '').trim(),
        category: (p.product_type || '').trim(),
        price: pick.price,
        regularPrice: regulars.length ? Math.max(...regulars) : null,
        url: `${origin}/products/${p.handle}`,
        inStock: avail.length > 0,
      });
    }
    log(`  partner (shopify) page ${page}: +${products.length}, total ${out.length}`);
    if (products.length < 250) break;
  }
  return out;
}

/**
 * Fetch a partner's full catalogue from their own site, auto-detecting the
 * platform. Returns the standard product shape. Throws if the platform isn't
 * supported (i.e. neither WooCommerce nor Shopify exposed a public catalogue).
 * @param {string} site  partner site URL or host
 */
export async function fetchPartnerCatalog(site, { log = () => {}, platform = 'auto' } = {}) {
  const origin = toOrigin(site);

  if (platform === 'woocommerce' || platform === 'auto') {
    const woo = await fetchWooCatalog(origin, log);
    if (woo.length) return { products: woo, platform: 'woocommerce' };
    if (platform === 'woocommerce') return { products: woo, platform: 'woocommerce' };
  }
  if (platform === 'shopify' || platform === 'auto') {
    const shop = await fetchShopifyCatalog(origin, log);
    if (shop.length) return { products: shop, platform: 'shopify' };
    if (platform === 'shopify') return { products: shop, platform: 'shopify' };
  }
  throw new Error(
    `Could not read a product catalogue from ${origin}. Supported platforms: ` +
      `WooCommerce (/wp-json/wc/store/v1/products) and Shopify (/products.json). ` +
      `This site appears to use neither, so it needs a custom adapter.`,
  );
}
