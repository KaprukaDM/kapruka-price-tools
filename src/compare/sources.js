// Catalogue fetchers for the two sites being reconciled, parameterised by
// partner so the same code works for any Kapruka partner (see the shared
// `partners` table in Supabase, src/compare/partners.js).
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
import { convertToLkr } from './fx.js';

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

// Some partner sites (e.g. dimoretail.lk) sit behind Cloudflare's bot-protection
// JS challenge, which 403s plain fetch() requests before our code ever sees the
// platform. A real (even headless) browser can pass that challenge; a bare
// fetch() cannot. Set DISABLE_BROWSER=1 on hosts with no Playwright browser
// installed (e.g. Render free tier) to skip this fallback entirely.
const BROWSER_DISABLED = /^(1|true)$/i.test(process.env.DISABLE_BROWSER || '');

// Kapruka geolocates prices by the real connecting IP (headers don't override it),
// so a server hosted abroad sees USD instead of LKR. Set SCRAPE_PROXY to a Sri
// Lankan-exit HTTP(S) proxy to force LKR pricing. Left blank, requests go direct
// (correct when the host itself is in Sri Lanka).
const SCRAPE_PROXY = process.env.SCRAPE_PROXY || '';
let proxyDispatcher; // lazily-created undici ProxyAgent, reused across requests

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A single page of pagination hitting a 429 used to kill the whole catalog
// fetch outright (multi-page partners like thinex/Joey Clothing/Shirohana
// trip Kapruka's rate limit partway through and never finish). Retry a 429 a
// few times with backoff — honouring Retry-After when Kapruka sends one —
// before giving up. Every other non-OK status still fails immediately, same
// as before.
const RATE_LIMIT_RETRIES = 7;

async function fetchText(url) {
  for (let attempt = 0; ; attempt++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000);
    const opts = { headers: UA, redirect: 'follow', signal: c.signal };
    if (SCRAPE_PROXY) {
      if (!proxyDispatcher) {
        const { ProxyAgent } = await import('undici');
        proxyDispatcher = new ProxyAgent(SCRAPE_PROXY);
      }
      opts.dispatcher = proxyDispatcher;
    }
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const retryAfter = Number(r.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 30000); // 1s, 2s, 4s, 8s, 16s, 30s, 30s
        await sleep(waitMs);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.text();
    } finally {
      clearTimeout(t);
    }
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

// Is this origin actively blocking us (as opposed to just not running
// WooCommerce/Shopify)? Checked once, only after both direct platform probes
// come back empty, so normal (unblocked) partners never pay for this extra call.
async function isCloudflareBlocked(origin) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    const opts = { headers: UA, redirect: 'follow', signal: c.signal };
    if (SCRAPE_PROXY) {
      if (!proxyDispatcher) {
        const { ProxyAgent } = await import('undici');
        proxyDispatcher = new ProxyAgent(SCRAPE_PROXY);
      }
      opts.dispatcher = proxyDispatcher;
    }
    const r = await fetch(origin, opts);
    clearTimeout(t);
    if (r.status !== 403) return false;
    return r.headers.get('cf-mitigated') != null || (r.headers.get('server') || '').toLowerCase() === 'cloudflare';
  } catch {
    return false;
  }
}

// Fetch JSON through a real headless browser instead of fetch() — the only way
// past a Cloudflare JS challenge. Slow (~5-10s) and not guaranteed to pass, so
// this is only ever tried as a last resort, never as the first attempt.
async function fetchJsonViaBrowser(url) {
  if (BROWSER_DISABLED) return null;
  try {
    const { chromium } = await import('playwright');
    const launchOpts = {};
    if (SCRAPE_PROXY) launchOpts.proxy = { server: SCRAPE_PROXY };
    const browser = await chromium.launch(launchOpts);
    try {
      const context = await browser.newContext({
        userAgent: UA['User-Agent'],
        extraHTTPHeaders: { 'Accept-Language': UA['Accept-Language'] },
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Cloudflare's managed challenge normally clears itself within a few seconds.
      await page.waitForTimeout(6000);
      const text = await page.evaluate(() => document.body.innerText);
      return JSON.parse(text);
    } finally {
      await browser.close();
    }
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
  // USD amounts have decimals (e.g. "33.29") that a digits-only parseInt would
  // truncate to 33, so keep the decimal here and round after currency conversion below.
  const priceNum = rawPrice != null ? parseFloat(String(rawPrice).replace(/[^0-9.]/g, '')) : NaN;
  let price = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;

  let currency =
    offer?.priceCurrency ||
    $('meta[property="product:price:currency"]').attr('content') ||
    'LKR';

  // Kapruka geo-converts prices for non-Sri-Lankan server IPs (see the note on
  // SCRAPE_ON_ADD in server.js — this VPS is confirmed to get bad geo-pricing).
  // Which currency it picks isn't fixed to USD — it can also come back as AED,
  // GBP, etc. depending on how the IP resolves. Single-product resolves have
  // no LKR-only fallback like the catalogue scraper's kaprukaLkrPriceMap
  // below, so convert whatever currency it is instead of displaying the
  // foreign number as if it were rupees.
  if (price != null && currency && !/^LKR$/i.test(currency)) {
    price = await convertToLkr(price, currency);
    currency = 'LKR';
  } else if (price != null) {
    price = Math.round(price);
  }

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

// The visible ".catalogueV2converted" price is GEO-CONVERTED: international
// visitors (e.g. a server hosted abroad) get it in USD, not LKR — so a Rs.219,000
// TV renders as "$811" and naively parsing the number stores 811 as if it were
// rupees. The per-product JSON-LD offer, however, carries the canonical LKR price
// regardless of geo. So we build an LKR price map from the JSON-LD (keyed by the
// product code in /kid/<code>) and use the visible span only as an LKR-only
// fallback. Regex over each <script> block rather than JSON.parse, because some
// product names contain characters that make the JSON-LD invalid JSON.
function kaprukaLkrPriceMap(html) {
  const map = new Map();
  const blocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    if (!/"@type"\s*:\s*"Product"/i.test(block)) continue;
    const url = (block.match(/"url"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const kid = (url.match(/\/kid\/([^/"?#]+)/i) || [])[1];
    if (!kid) continue;
    const cur = (block.match(/"priceCurrency"\s*:\s*"?(\w+)/i) || [])[1];
    const priceStr = (block.match(/"price"\s*:\s*"?([\d.]+)/i) || [])[1];
    if (!priceStr || !/^LKR$/i.test(cur || '')) continue; // only trust LKR offers
    const price = Math.round(parseFloat(priceStr));
    if (Number.isFinite(price) && price > 0) map.set(kid.toLowerCase(), price);
  }
  return map;
}

function parseKaprukaPage(html) {
  const $ = cheerio.load(html);
  const lkrByKid = kaprukaLkrPriceMap(html);
  const out = [];
  $('a[href*="/buyonline/"]').each((_, el) => {
    const $a = $(el);
    const heading = $a.find('.catalogueV2heading').first();
    if (heading.length === 0) return; // not a product card (e.g. a plain link)
    const name = fixMojibake(decodeEntities(heading.text()).replace(/\s+/g, ' ').trim());
    if (!name) return;
    const href = $a.attr('href') || '';
    const kid = (href.match(/\/kid\/([^/"?#]+)/i) || [])[1];

    // 1) Canonical LKR price from JSON-LD (geo-independent).
    let price = kid ? lkrByKid.get(kid.toLowerCase()) ?? null : null;

    // 2) Fallback: the visible price, but ONLY when it's rendered in LKR. If the
    //    page geo-converted to USD/another currency, leave price null rather than
    //    storing a foreign number as rupees.
    if (price == null) {
      const priceEl = $a.find('.catalogueV2converted, .CatalogueV2price').first().clone();
      priceEl.find('[style*="line-through"]').remove();
      const txt = priceEl.text();
      if (/rs\.?|lkr|₨/i.test(txt)) {
        const m = txt.match(/(\d[\d,]*)/);
        price = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
      }
    }
    out.push({ name, price, url: href, inStock: true });
  });
  return out;
}

// `source` is a descriptor from parseKaprukaSource(), or a raw link/slug string.
export async function fetchKaprukaCatalog(source, { log = () => {} } = {}) {
  const src = typeof source === 'string' ? parseKaprukaSource(source) : source;
  if (!src) throw new Error('Unrecognised Kapruka link/source');
  const base = kaprukaBaseUrl(src);
  const byUrl = new Map();
  // Safety ceiling only — the loop's real stopping conditions are an empty
  // page or a page that adds nothing new. 50 was too low for large
  // categories (Electronics has 3000+ products, ~115 pages at 30/page) and
  // was silently truncating them instead of ever being hit as a genuine
  // safety net.
  for (let p = 1; p <= 300; p++) {
    if (p > 1) await sleep(600); // throttle page requests to avoid tripping Kapruka's rate limit
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
// { platform: 'woocommerce' | 'shopify' | null, viaBrowser: boolean, blocked: boolean }.
// `viaBrowser` tells the caller to persist that flag on the partner, so every
// later comparison run for this partner goes straight to the browser fetch
// instead of wasting time on a direct request that's known to be blocked.
// `blocked` (only meaningful when platform is null) distinguishes "the site
// sits behind Cloudflare/bot-protection and we couldn't get through even via
// a real browser" from "we got through fine, it's just not WooCommerce or
// Shopify" — callers use this to route unsupported sites into two different
// worklists (custom scraper needed vs. block-evasion needed).
export async function detectPartnerPlatform(site) {
  const origin = toOrigin(site);
  const woo = await fetchJsonSafe(`${origin}/wp-json/wc/store/v1/products?per_page=1`);
  if (Array.isArray(woo) && woo.length) return { platform: 'woocommerce', viaBrowser: false, blocked: false };
  const shop = await fetchJsonSafe(`${origin}/products.json?limit=1`);
  if (shop && Array.isArray(shop.products) && shop.products.length) return { platform: 'shopify', viaBrowser: false, blocked: false };

  const blocked = await isCloudflareBlocked(origin);
  if (blocked) {
    const wooB = await fetchJsonViaBrowser(`${origin}/wp-json/wc/store/v1/products?per_page=1`);
    if (Array.isArray(wooB) && wooB.length) return { platform: 'woocommerce', viaBrowser: true, blocked: false };
    const shopB = await fetchJsonViaBrowser(`${origin}/products.json?limit=1`);
    if (shopB && Array.isArray(shopB.products) && shopB.products.length) return { platform: 'shopify', viaBrowser: true, blocked: false };
  }
  return { platform: null, viaBrowser: false, blocked };
}

// ---- Partner site (auto-detected platform) -------------------------------

function minorUnitDivide(value, minorUnit) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return minorUnit ? n / 10 ** minorUnit : n;
}

// Pull the first plausible number out of a price string, ignoring whatever
// currency symbol precedes it (Rs., LKR, the Sinhala රු, etc.) -- used by the
// WooCommerce HTML fallback below, which reads prices straight off rendered
// markup rather than a currency-tagged API field.
function parsePriceLKR(text) {
  if (text == null) return null;
  const m = String(text).match(/[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// WooCommerce Store API: /wp-json/wc/store/v1/products?per_page=100&page=N.
// Prices are integer strings scaled by currency_minor_unit.
//
// Some sites (e.g. thinex.lk) 404 on the pretty /wp-json/... permalink (their
// server rewrite rules don't cover it) but still serve the same data via the
// query-param form. Probe the pretty URL first; if page 1 comes back non-array,
// retry via ?rest_route= and stick with it for the rest of pagination. Without
// this fallback the pretty URL's 404 silently looks like "empty catalogue"
// (fetchJsonSafe returns null on error) rather than a real failure — nothing
// throws, so a force-refresh happily overwrites good stored data with zero.
async function fetchWooCatalog(origin, log, fetchJson = fetchJsonSafe) {
  const out = [];
  let useRestRoute = false;
  for (let page = 1; page <= 100; page++) {
    const prettyUrl = `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
    const restRouteUrl = `${origin}/?rest_route=/wc/store/v1/products&per_page=100&page=${page}`;
    let arr = await fetchJson(useRestRoute ? restRouteUrl : prettyUrl);
    if (!Array.isArray(arr) && page === 1 && !useRestRoute) {
      arr = await fetchJson(restRouteUrl);
      if (Array.isArray(arr)) useRestRoute = true;
    }
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

// Shopify's public /products.json carries no currency field at all — prices
// are just bare numbers in whatever currency the store's checkout is set to.
// Most Sri Lankan stores run LKR, but some (e.g. ekko.style) run USD, and a
// bare number was previously stored as if it were rupees — turning a $66
// shirt into "Rs. 66", which then reads as wildly "overpriced" on Kapruka's
// side. /cart.json is a stable, unauthenticated Shopify endpoint that always
// reports the store's real currency, even for an empty cart.
async function shopifyStoreCurrency(origin, fetchJson) {
  const cart = await fetchJson(`${origin}/cart.json`);
  const cur = String(cart?.currency || '').toUpperCase();
  return cur || 'LKR';
}

// Shopify: /products.json?limit=250&page=N. Prices are major-unit strings; we
// take the cheapest available variant and its SKU.
async function fetchShopifyCatalog(origin, log, fetchJson = fetchJsonSafe) {
  const out = [];
  const currency = await shopifyStoreCurrency(origin, fetchJson).catch(() => 'LKR');
  if (currency !== 'LKR') log(`  partner (shopify) store currency: ${currency} — converting prices to LKR`);
  for (let page = 1; page <= 100; page++) {
    const data = await fetchJson(`${origin}/products.json?limit=250&page=${page}`);
    const products = data && Array.isArray(data.products) ? data.products : null;
    if (!products || products.length === 0) break;
    for (const p of products) {
      const variants = (p.variants || [])
        .map((v) => ({
          price: parseFloat(v.price),
          regularPrice: parseFloat(v.compare_at_price),
          sku: v.sku,
          available: v.available !== false,
        }))
        .filter((v) => Number.isFinite(v.price) && v.price > 0);
      if (variants.length === 0) continue;
      // Prefer the first variant marked available (Shopify's default/first-
      // shown option) over the globally cheapest one. Some listings mix wildly
      // different price tiers under one product -- e.g. this book's variants
      // are "Perfect" Rs.9,400 / "Paperback" Rs.2,200 / "Imperfect" Rs.1,000 --
      // and picking the minimum grabbed a damaged-copy price instead of the
      // standard listing, making a fair-priced product look 10x overpriced.
      const pick = variants.find((v) => v.available) || variants[0];
      const price = currency === 'LKR' ? Math.round(pick.price) : await convertToLkr(pick.price, currency);
      const regularPrice = Number.isFinite(pick.regularPrice) && pick.regularPrice > 0
        ? (currency === 'LKR' ? Math.round(pick.regularPrice) : await convertToLkr(pick.regularPrice, currency))
        : null;
      out.push({
        id: `shopify-${p.id}`,
        name: decodeEntities(p.title || '').trim(),
        sku: pick.sku || '',
        // product_type ~ category; vendor ~ brand (note: vendor is often the store
        // name on Shopify, so treat it as a best-effort brand signal).
        brand: (p.vendor || '').trim(),
        category: (p.product_type || '').trim(),
        price,
        regularPrice,
        url: `${origin}/products/${p.handle}`,
        inStock: variants.some((v) => v.available),
      });
    }
    log(`  partner (shopify) page ${page}: +${products.length}, total ${out.length}`);
    if (products.length < 250) break;
  }
  return out;
}

// Fallback for WooCommerce sites whose Store API (/wp-json/wc/store/v1/...)
// is disabled, blocked, or absent -- scrape the public shop listing pages
// directly instead. WooCommerce's *price* markup (.price / .woocommerce-
// Price-amount) is rendered by the plugin's own PHP templates, not the theme,
// so it survives across wildly different themes even when the surrounding
// grid markup (ul.products vs theme-specific divs) doesn't. Strategy: find
// every /product/<slug>/ permalink on the page, walk up from each link to the
// nearest ancestor that also contains a .price element (and not so many
// product links that we've walked past the card into the whole grid), and
// read the title/price from there. `shopUrl` must be the exact listing page
// (e.g. "https://site.com/shop/"), not just the origin -- these sites don't
// follow one consistent path.
function parseWooHtmlPage(html, origin) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const out = [];
  $('a[href*="/product/"]').each((_, el) => {
    const $a = $(el);
    let href = $a.attr('href');
    if (!href) return;
    href = href.split('?')[0].split('#')[0];
    if (!href.endsWith('/')) href += '/';
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;

    let $card = $a;
    let found = null;
    for (let i = 0; i < 8; i++) {
      $card = $card.parent();
      if ($card.length === 0) break;
      const linkCount = $card.find('a[href*="/product/"]').length;
      if ($card.find('.price').first().length && linkCount <= 3) { found = $card; break; }
      if (linkCount > 3) break; // walked past the card into the whole grid
    }
    if (!found) return;

    const priceEl = found.find('.price').first();
    const saleAmt = priceEl.find('ins .woocommerce-Price-amount, ins .amount').first();
    const amt = saleAmt.length ? saleAmt : priceEl.find('.woocommerce-Price-amount, .amount').first();
    const price = parsePriceLKR((amt.length ? amt : priceEl).text());
    if (!price) return;

    const title = fixMojibake(decodeEntities(
      found.find('h1,h2,h3,h4,.woocommerce-loop-product__title,.wd-entities-title,.product-title,.product_title')
        .first().text() || $a.attr('aria-label') || $a.attr('title') || $a.text(),
    )).replace(/\s+/g, ' ').trim();
    if (!title) return;

    seen.add(href);
    out.push({ id: `woohtml-${href}`, name: title, price, url: href });
  });
  return out;
}

async function fetchWooHtmlCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const base = shopUrl.replace(/\/?$/, '/');
  const byUrl = new Map();
  for (let page = 1; page <= 60; page++) {
    const url = page === 1 ? base : `${base}page/${page}/`;
    let html;
    try {
      html = await fetchTextFn(url);
    } catch {
      break; // page N/A (404 past the last page) -- stop, not a real failure
    }
    const products = parseWooHtmlPage(html, origin);
    if (products.length === 0) break;
    let added = 0;
    for (const p of products) {
      if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; }
    }
    log(`  partner (woo-html) page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
    if (added === 0) break; // pagination wrapped or plateaued
    if (page > 1) await sleep(500); // be polite -- this is a full page render, not a lightweight API call
  }
  return [...byUrl.values()];
}

/**
 * Fetch a partner's full catalogue from their own site, auto-detecting the
 * platform. Returns the standard product shape. Throws if the platform isn't
 * supported (i.e. neither WooCommerce nor Shopify exposed a public catalogue).
 * @param {string} site  partner site URL or host
 * @param {{ log?: (m: string) => void, platform?: string, viaBrowser?: boolean }} [opts]
 *   `viaBrowser` should be true for partners already known to sit behind a
 *   Cloudflare-style block (persisted from detectPartnerPlatform's result).
 */
export async function fetchPartnerCatalog(site, { log = () => {}, platform = 'auto', viaBrowser = false } = {}) {
  const origin = toOrigin(site);
  const fetchJson = viaBrowser ? fetchJsonViaBrowser : fetchJsonSafe;

  if (platform === 'woocommerce-html') {
    const products = await fetchWooHtmlCatalog(site, log);
    return { products, platform: 'woocommerce-html' };
  }
  if (platform === 'woocommerce' || platform === 'auto') {
    const woo = await fetchWooCatalog(origin, log, fetchJson);
    if (woo.length) return { products: woo, platform: 'woocommerce' };
    if (platform === 'woocommerce') return { products: woo, platform: 'woocommerce' };
  }
  if (platform === 'shopify' || platform === 'auto') {
    const shop = await fetchShopifyCatalog(origin, log, fetchJson);
    if (shop.length) return { products: shop, platform: 'shopify' };
    if (platform === 'shopify') return { products: shop, platform: 'shopify' };
  }
  // Direct fetch found nothing in auto mode — if the site is actively blocking
  // us, retry once through a real browser before giving up.
  if (!viaBrowser && platform === 'auto' && (await isCloudflareBlocked(origin))) {
    return fetchPartnerCatalog(site, { log, platform: 'auto', viaBrowser: true });
  }
  throw new Error(
    `Could not read a product catalogue from ${origin}. Supported platforms: ` +
      `WooCommerce (/wp-json/wc/store/v1/products) and Shopify (/products.json). ` +
      `This site appears to use neither, so it needs a custom adapter.`,
  );
}
