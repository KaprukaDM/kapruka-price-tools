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
import { index } from './matcher.js';

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

// Some WAFs (Wordfence, generic bot-fight heuristics) 403 requests that lack a
// standard browser Accept header or that self-identify as a bot, even with no
// JS challenge involved -- a realistic UA + Accept header alone gets through.
const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-LK,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

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
// Also builds the per-product stock map alongside price: each catalogue-page
// product card carries its own Product JSON-LD block (same one price is read
// from above), and that block's offers.availability is a genuine, geo-independent
// schema.org InStock/OutOfStock signal — not previously read, so parseKaprukaPage()
// below used to hardcode every Kapruka product as in stock regardless of reality.
function kaprukaLkrPriceMap(html) {
  const priceMap = new Map();
  const stockMap = new Map();
  const blocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    if (!/"@type"\s*:\s*"Product"/i.test(block)) continue;
    const url = (block.match(/"url"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const kid = (url.match(/\/kid\/([^/"?#]+)/i) || [])[1];
    if (!kid) continue;
    const kidKey = kid.toLowerCase();
    const cur = (block.match(/"priceCurrency"\s*:\s*"?(\w+)/i) || [])[1];
    const priceStr = (block.match(/"price"\s*:\s*"?([\d.]+)/i) || [])[1];
    if (priceStr && /^LKR$/i.test(cur || '')) {
      const price = Math.round(parseFloat(priceStr));
      if (Number.isFinite(price) && price > 0) priceMap.set(kidKey, price);
    }
    const availability = (block.match(/"availability"\s*:\s*"([^"]+)"/) || [])[1];
    if (availability) stockMap.set(kidKey, !/OutOfStock/i.test(availability));
  }
  return { priceMap, stockMap };
}

function parseKaprukaPage(html) {
  const $ = cheerio.load(html);
  const { priceMap: lkrByKid, stockMap: stockByKid } = kaprukaLkrPriceMap(html);
  const out = [];
  $('a[href*="/buyonline/"]').each((_, el) => {
    const $a = $(el);
    const heading = $a.find('.catalogueV2heading').first();
    if (heading.length === 0) return; // not a product card (e.g. a plain link)
    const name = fixMojibake(decodeEntities(heading.text()).replace(/\s+/g, ' ').trim());
    if (!name) return;
    const href = $a.attr('href') || '';
    const kid = (href.match(/\/kid\/([^/"?#]+)/i) || [])[1];
    const kidKey = kid ? kid.toLowerCase() : null;

    // 1) Canonical LKR price from JSON-LD (geo-independent).
    let price = kidKey ? lkrByKid.get(kidKey) ?? null : null;

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
    // Default to in-stock when a card has no JSON-LD availability of its own
    // (rare) rather than assuming the worse case for missing data.
    const inStock = kidKey && stockByKid.has(kidKey) ? stockByKid.get(kidKey) : true;
    out.push({ name, price, url: href, inStock });
  });
  return out;
}

// How much of the query's own tokens show up in a candidate title. One-
// directional and deliberately not run through matcher.js's score() or
// audit-scoring.js's scoreCandidate() -- both are tuned for cross-site
// IDENTITY matching (near-duplicate SKU across two catalogues) and reject
// on any of several narrower grounds that don't apply here: matcher.js's
// score() requires the CANDIDATE's tokens be near-fully contained in the
// query too (fails on any real listing, which always carries extra words
// like "MagSafe"/"Clear"/"Sri Lanka"), and scoreCandidate()'s
// accessoryMismatch() treats "case" and "cover" as different accessory
// categories (rejects "iPhone 12 cover" against a real "...Clear Case"
// listing, confirmed live). This just ranks Kapruka's OWN already-
// relevance-sorted search results by query-token coverage -- Kapruka's own
// search engine did the hard filtering; this only needs to pick the best
// of what it already returned.
function queryCoverage(qTokens, cTokens) {
  if (!qTokens.size) return 0;
  let matched = 0;
  for (const t of qTokens) if (cTokens.has(t)) matched++;
  return matched / qTokens.size;
}

// Live search of Kapruka's OWN site (kapruka.com/lk/find_online/<query>) for
// a product by name -- same server-rendered catalogue-card markup as a
// partner's storefront page, so parseKaprukaPage() above reads it directly,
// no separate parser needed.
//
// Built for the Price Checker's price-insight step: that needs Kapruka's
// OWN current price for whatever was typed, but price_audit_items (the
// pre-scraped/audited table) only has a price for products someone has
// already run a category audit against -- a plain, never-audited query
// (e.g. "iPhone 12 cover") had no Kapruka price to compare against at all,
// so no recommendation could ever be shown for it. This covers every
// search, not just ones that happen to already be in that table.
// Full containment, not "most" tokens -- a partial-coverage bar let "iPhone
// 17 MagSafe Cover" satisfy a "iPhone 12 cover" query at 2/3 (iphone+cover)
// purely off two generic words, without the model number "12" itself ever
// matching. For a short query every word carries weight, especially the
// one that's actually a model number -- require all of them.
const KAPRUKA_MATCH_MIN_COVERAGE = 1;

export async function findKaprukaProduct(name) {
  const url = `https://www.kapruka.com/lk/find_online/${encodeURIComponent(name)}`;
  let html;
  try {
    html = await fetchText(url);
  } catch {
    return null;
  }
  const candidates = parseKaprukaPage(html).filter((p) => p.price != null);
  if (!candidates.length) return null;

  const [qIndexed] = index([{ name, url: 'query' }], false);
  const indexed = index(candidates, false);
  // Kapruka's own search already relevance-sorts its results -- take the
  // first one clearing the coverage floor, not the "best-scoring" one
  // (maximizing token overlap can prefer a longer, coincidentally-wordier
  // listing over the genuinely most relevant top result).
  for (const c of indexed) {
    if (queryCoverage(qIndexed._tokens, c._tokens) >= KAPRUKA_MATCH_MIN_COVERAGE) {
      return { name: c.name, url: c.url.startsWith('http') ? c.url : `https://www.kapruka.com${c.url}`, price: c.price };
    }
  }
  return null;
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

// The HTML-scraped adapters below (unlike the WooCommerce REST / Shopify
// paths above, which read the site's own currency-tagged field) have no
// currency field to lean on at all -- just whatever text the theme renders.
// A site that's actually priced in USD ("$45.99") was silently treated as
// Rs. 45.99 by parsePriceLKR, which ignores the symbol entirely -- massively
// underpricing that partner everywhere it's compared. Flag it here instead:
// a "$"/"USD" with no accompanying Rs./LKR marker on the same string is USD,
// everything else stays LKR exactly as before.
function parsePriceMaybeForeign(text) {
  const price = parsePriceLKR(text);
  if (price == null) return null;
  const s = String(text || '');
  const isUsd = /\$|USD/i.test(s) && !/Rs\.?|LKR|රු/i.test(s);
  return { price, currency: isUsd ? 'USD' : 'LKR' };
}

// cheerio's .each() callback can't be async, so parsePriceMaybeForeign just
// flags a foreign price during that (synchronous) pass -- this converts the
// flagged ones afterwards, in one batch. convertToLkr() caches its FX rate
// per currency for 30 minutes, so this costs at most one network call per
// currency per catalogue fetch, not one per product.
async function convertForeignItems(items) {
  for (const item of items) {
    if (item._currency && item._currency !== 'LKR' && item.price != null) {
      item.price = await convertToLkr(item.price, item._currency);
    }
    delete item._currency;
  }
  return items;
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
async function parseWooHtmlPage(html, origin) {
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
    const parsed = parsePriceMaybeForeign((amt.length ? amt : priceEl).text());
    if (!parsed) return;

    const title = fixMojibake(decodeEntities(
      found.find('h1,h2,h3,h4,.woocommerce-loop-product__title,.wd-entities-title,.product-title,.product_title')
        .first().text() || $a.attr('aria-label') || $a.attr('title') || $a.text(),
    )).replace(/\s+/g, ' ').trim();
    if (!title) return;

    seen.add(href);
    out.push({ id: `woohtml-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

// Some sites front WooCommerce with a WAF (Wordfence, Cloudflare bot-fight) that
// intermittently 403s a fresh page render while a cached hit sails straight
// through -- same origin, same request, different result a few seconds apart.
// A 403/429/503 is worth a couple of retries; a 404 past the last page is not.
const TRANSIENT_STATUS = /HTTP (403|429|503)\b/;

async function fetchWooHtmlCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const base = shopUrl.replace(/\/?$/, '/');
  const byUrl = new Map();
  for (let page = 1; page <= 60; page++) {
    const url = page === 1 ? base : `${base}page/${page}/`;
    let html;
    for (let attempt = 0; ; attempt++) {
      try {
        html = await fetchTextFn(url);
        break;
      } catch (e) {
        if (TRANSIENT_STATUS.test(e.message) && attempt < 3) {
          await sleep(4000 * (attempt + 1));
          continue;
        }
        html = null;
        break; // page N/A (404 past the last page, or a block that didn't clear) -- stop
      }
    }
    if (html == null) break;
    const products = await parseWooHtmlPage(html, origin);
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

// ---- Bespoke per-site adapters --------------------------------------------
// A handful of partners run hand-coded storefronts sharing no common CMS, so
// each needs its own small scraper. All return the standard [{ id, name,
// price, url }] shape fetchPartnerCatalog expects.

// -- Odoo (website_sale) -- shared by disnies.lk and harvest.lk (and any
// future Odoo-based partner). Card markup differs slightly by theme/version
// between the two confirmed installs, so this reads from whichever stable
// class/attribute is present rather than one exact selector.
async function parseOdooListingPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('form.oe_product_cart').each((_, el) => {
    const $card = $(el);
    const $link = $card.find('a.oe_product_image_link[href]').first();
    let href = $link.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    const parsed = parsePriceMaybeForeign($card.find('.oe_currency_value').first().text());
    if (!parsed) return;
    const nameLink = $card.find('a[itemprop="name"]').first();
    const title = fixMojibake(decodeEntities(
      (nameLink.length ? nameLink.text() : '') || $link.attr('title') || $link.find('img').attr('alt') || '',
    )).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `odoo-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchOdooCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const base = shopUrl.replace(/\/?$/, '');
  const byUrl = new Map();
  for (let page = 1; page <= 60; page++) {
    const url = page === 1 ? base : `${base}/page/${page}`;
    let html;
    for (let attempt = 0; ; attempt++) {
      try {
        html = await fetchTextFn(url);
        break;
      } catch (e) {
        if (TRANSIENT_STATUS.test(e.message) && attempt < 3) {
          await sleep(4000 * (attempt + 1));
          continue;
        }
        html = null;
        break;
      }
    }
    if (html == null) break;
    const products = await parseOdooListingPage(html, origin);
    if (products.length === 0) break;
    let added = 0;
    for (const p of products) {
      if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; }
    }
    log(`  partner (odoo) page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
    if (added === 0) break;
    if (page > 1) await sleep(500);
  }
  return [...byUrl.values()];
}

// -- ichouse.lk (Pubudu Electronics) -- the whole catalogue lives in one
// public Firestore document (no auth needed); a single request beats
// crawling category pages. Firestore's REST API wraps every value in a
// type tag ({ stringValue, integerValue, arrayValue, mapValue, ... }).
function unwrapFirestoreValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(unwrapFirestoreValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = unwrapFirestoreValue(val);
    return out;
  }
  return null;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

async function fetchIchouseCatalog(fetchJson = fetchJsonSafe) {
  const url = 'https://firestore.googleapis.com/v1/projects/pubudueshop-cde28/databases/(default)/documents/shop/inventory';
  const doc = await fetchJson(url);
  const products = doc?.fields?.products?.arrayValue?.values || [];
  const out = [];
  for (const raw of products) {
    const p = unwrapFirestoreValue(raw);
    if (!p || !p.title || !p.price) continue;
    const slug = `${slugify(p.mainCategory)}/${slugify(p.subCategory)}/${slugify(p.title)}`;
    out.push({ id: `ichouse-${p.id}`, name: p.title, price: Math.round(p.price), url: `https://ichouse.lk/${slug}/` });
  }
  return out;
}

// -- kidsmarket.lk -- CodeIgniter storefront; pagination is a path offset
// (12 products/page). Page 1's pagination widget exposes the total page
// count directly, so no guessing is needed.
async function parseKidsmarketPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/product/kidsmarket/"]').each((_, el) => {
    const $a = $(el);
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    let $card = $a;
    let priceEl = null;
    for (let i = 0; i < 6; i++) {
      $card = $card.parent();
      if ($card.length === 0) break;
      const p = $card.find('p.text-xl.font-bold.text-brand-blue').first();
      if (p.length) { priceEl = p; break; }
    }
    if (!priceEl) return;
    const parsed = parsePriceMaybeForeign(priceEl.text());
    if (!parsed) return;
    const title = fixMojibake(decodeEntities(
      $card.find('h4.font-semibold.text-lg.text-brand-dark').first().text() || $a.text(),
    )).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `kidsmarket-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchKidsmarketCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const base = `${origin}/shop/products`;
  let html;
  try { html = await fetchTextFn(base); } catch { return []; }
  const byUrl = new Map();
  for (const p of await parseKidsmarketPage(html, origin)) byUrl.set(p.url, p);
  log(`  partner (kidsmarket) page 1: ${byUrl.size} cards`);
  let lastPage = 1;
  const $page1 = cheerio.load(html);
  $page1('[data-ci-pagination-page]').each((_, el) => {
    const n = Number($page1(el).attr('data-ci-pagination-page'));
    if (Number.isFinite(n) && n > lastPage) lastPage = n;
  });
  const PER_PAGE = 12;
  for (let page = 2; page <= lastPage; page++) {
    const offset = (page - 1) * PER_PAGE;
    let h;
    for (let attempt = 0; ; attempt++) {
      try { h = await fetchTextFn(`${base}/${offset}`); break; }
      catch (e) {
        if (TRANSIENT_STATUS.test(e.message) && attempt < 3) { await sleep(4000 * (attempt + 1)); continue; }
        h = null;
        break;
      }
    }
    if (h == null) break;
    const products = await parseKidsmarketPage(h, origin);
    let added = 0;
    for (const p of products) { if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; } }
    log(`  partner (kidsmarket) page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
    await sleep(500);
  }
  return [...byUrl.values()];
}

// -- liveu.lk -- Laravel storefront whose listing endpoint honours a
// per_page override, so the whole catalogue comes back in one request.
async function parseLiveuPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.vertical-product-card').each((_, el) => {
    const $card = $(el);
    const $a = $card.find('a.card-title').first();
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    const parsed = parsePriceMaybeForeign($card.find('h6.price span.text-danger').first().text());
    if (!parsed) return;
    const title = fixMojibake(decodeEntities($a.text())).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `liveu-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchLiveuCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const html = await fetchTextFn(`${origin}/products?per_page=500`);
  const products = await parseLiveuPage(html, origin);
  log(`  partner (liveu) single page: ${products.length} cards`);
  return products;
}

// -- scgraphic.com (SC Promotion) -- entire catalogue renders on one page.
async function parseScgraphicPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.product-card').each((_, el) => {
    const $card = $(el);
    const $a = $card.find('a.btn-details[href]').first();
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    const $discounted = $card.find('span.discounted-price').first();
    const priceEl = $discounted.length ? $discounted : $card.find('span.regular-price').first();
    const parsed = parsePriceMaybeForeign(priceEl.text());
    if (!parsed) return;
    const title = fixMojibake(decodeEntities($card.find('div.product-name').first().text())).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `scgraphic-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchScgraphicCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const html = await fetchTextFn(`${origin}/shop.php`);
  const products = await parseScgraphicPage(html, origin);
  log(`  partner (scgraphic) single page: ${products.length} cards`);
  return products;
}

// -- Agrola Ceylon's Daraz shop -- Daraz's shop product grid is loaded via a
// signed internal API with no static fallback, and its search/pagination
// endpoints trip Alibaba's TMD anti-bot challenge (an active CAPTCHA wall,
// not a header check -- not something to route around). Manually maintained
// from the shop page instead: https://www.daraz.lk/shop/x4cu9fso/
// Update by re-checking that page and editing the list below.
const AGROLA_DARAZ_SHOP_URL = 'https://www.daraz.lk/shop/x4cu9fso/';
const AGROLA_DARAZ_PRODUCTS = [
  { name: 'AGROLA Ceylon Cinnamon Antioxidant Booster Tea | 3-Pack Combo', price: 2025 },
  { name: 'AGROLA Ceylon Cinnamon Detox & Weight Loss Tea - 20 Tea Bags', price: 750 },
  { name: 'AGROLA Ceylon Hibiscus Spearmint Herbal Tea - 20 Tea Bags', price: 750 },
  { name: 'Agrola Ceylon Moringa Super Wellness Herbal Tea - 20 Tea Bags', price: 750 },
  { name: 'AGROLA Ceylon Cinnamon Antioxidant Booster Tea - 20 Tea Bags', price: 750 },
];

async function fetchAgrolaDarazCatalog(log) {
  log(`  partner (agrola-daraz) manually maintained list: ${AGROLA_DARAZ_PRODUCTS.length} products`);
  return AGROLA_DARAZ_PRODUCTS.map((p, i) => ({
    id: `agrola-daraz-${i}`,
    name: p.name,
    price: p.price,
    url: AGROLA_DARAZ_SHOP_URL,
  }));
}

// -- jeewakaherbals.com/jhstore -- AbanteCart storefront; the brand's main
// domain is a marketing page, the real store lives under /jhstore/ across
// three known category paths (8 products/page).
const JHSTORE_CATEGORY_PATHS = [43, 52, 68];

async function parseJhstorePage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.product-card').each((_, el) => {
    const $card = $(el);
    const $a = $card.find('a[href*="rt=product/product"]').first();
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    const parsed = parsePriceMaybeForeign($card.find('div.price').first().text());
    if (!parsed) return; // also drops genuine Rs.0.00 "call for price" entries
    const title = fixMojibake(decodeEntities($card.find('div.card-title').first().text())).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `jhstore-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchJhstoreCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const byUrl = new Map();
  for (const path of JHSTORE_CATEGORY_PATHS) {
    for (let page = 1; page <= 20; page++) {
      const url = `${origin}/jhstore/index.php?rt=product/category&path=${path}&page=${page}&limit=8`;
      let html;
      try { html = await fetchTextFn(url); } catch { break; }
      const products = await parseJhstorePage(html, origin);
      if (products.length === 0) break;
      let added = 0;
      for (const p of products) { if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; } }
      log(`  partner (jhstore) path=${path} page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
      if (added === 0) break;
      await sleep(400);
    }
  }
  return [...byUrl.values()];
}

// -- limitededition.lk -- OpenCart (Journal theme). The Store-API probes both
// miss it (it's neither Woo nor Shopify) and it publishes no XML sitemap or
// product feed, so there's no single endpoint listing the whole catalogue.
// The category pages only cover part of it (several products sit solely in
// month "collection" categories that aren't linked from the main nav), so
// instead this drives OpenCart's own search route, which does span every
// category, and unions the results of a few single-letter queries. Nearly
// every product name contains at least one of these, and each letter
// independently returns ~the full 109-product catalogue -- the union is
// belt-and-braces against a name that happens to miss one.
const LIMITEDEDITION_SEARCH_TERMS = ['a', 'e', 'i', 'o', 'u', 's'];

function parseLimitedEditionPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.product-thumb').each((_, el) => {
    const $card = $(el);
    const $a = $card.find('h4.name a').first();
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    // Listing links carry the paging params through (…?limit=100) -- strip the
    // query so the same product found via two different searches dedupes.
    href = href.split('?')[0];
    if (seen.has(href)) return;
    const $price = $card.find('div.price').first();
    // On a discounted product the theme renders both the struck-through
    // original (.price-old) and the live one (.price-new); undiscounted
    // products just have the bare text. Take .price-new when present so a
    // sale price isn't misread as the regular price, and keep .price-old as
    // regularPrice so the dashboard's discount badge works the same way it
    // does for Woo's regular_price / Shopify's compare_at_price.
    const $new = $price.find('.price-new').first();
    const parsed = parsePriceMaybeForeign($new.length ? $new.text() : $price.clone().children().remove().end().text());
    if (!parsed) return;
    const $old = $price.find('.price-old').first();
    const regular = $old.length ? parsePriceLKR($old.text()) : null;
    const title = fixMojibake(decodeEntities($a.text())).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({
      id: `limitededition-${href}`,
      name: title,
      price: parsed.price,
      regularPrice: regular,
      url: href,
      _currency: parsed.currency,
    });
  });
  return convertForeignItems(out);
}

async function fetchLimitedEditionCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const byUrl = new Map();
  for (const term of LIMITEDEDITION_SEARCH_TERMS) {
    for (let page = 1; page <= 20; page++) {
      const url = `${origin}/index.php?route=product/search&search=${term}&limit=100&page=${page}`;
      let html;
      for (let attempt = 0; ; attempt++) {
        try { html = await fetchTextFn(url); break; }
        catch (e) {
          if (TRANSIENT_STATUS.test(e.message) && attempt < 3) { await sleep(4000 * (attempt + 1)); continue; }
          html = null;
          break;
        }
      }
      if (html == null) break;
      const products = await parseLimitedEditionPage(html, origin);
      if (products.length === 0) break;
      let added = 0;
      for (const p of products) { if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; } }
      log(`  partner (limitededition) search=${term} page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
      // "Showing 1 to 100 of 109 (2 Pages)" -- stop once this term is exhausted
      // rather than fetching a page that's guaranteed empty.
      const shown = html.match(/Showing\s+\d+\s+to\s+(\d+)\s+of\s+(\d+)/i);
      if (shown && Number(shown[1]) >= Number(shown[2])) break;
      await sleep(400);
    }
  }
  return [...byUrl.values()];
}

// -- foreverskinnaturals.com -- static-exported Next.js shell with no
// server-rendered content at all; the frontend's own backend API returns
// the full catalogue as clean JSON, one entry per size/price variant.
async function fetchForeverskinCatalog(fetchJson = fetchJsonSafe) {
  const doc = await fetchJson('https://api.foreverskinnaturals.com/v1/api/product/all?page=0&size=500');
  const list = doc?.data?.list || [];
  const out = [];
  for (const p of list) {
    for (const s of p.sizes || []) {
      const parsed = parsePriceMaybeForeign(s.price);
      if (!parsed) continue;
      const price = parsed.currency === 'LKR' ? parsed.price : await convertToLkr(parsed.price, parsed.currency);
      out.push({
        id: `foreverskin-${p.id}-${s.sizeId}`,
        name: s.size ? `${p.name} ${s.size}` : p.name,
        price,
        url: `https://foreverskinnaturals.com/product/${p.id}`,
      });
    }
  }
  return out;
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
  if (platform === 'odoo') {
    const products = await fetchOdooCatalog(site, log);
    return { products, platform: 'odoo' };
  }
  if (platform === 'ichouse') {
    const products = await fetchIchouseCatalog(fetchJson);
    return { products, platform: 'ichouse' };
  }
  if (platform === 'kidsmarket') {
    const products = await fetchKidsmarketCatalog(site, log);
    return { products, platform: 'kidsmarket' };
  }
  if (platform === 'liveu') {
    const products = await fetchLiveuCatalog(site, log);
    return { products, platform: 'liveu' };
  }
  if (platform === 'scgraphic') {
    const products = await fetchScgraphicCatalog(site, log);
    return { products, platform: 'scgraphic' };
  }
  if (platform === 'agrola-daraz') {
    const products = await fetchAgrolaDarazCatalog(log);
    return { products, platform: 'agrola-daraz' };
  }
  if (platform === 'jhstore') {
    const products = await fetchJhstoreCatalog(site, log);
    return { products, platform: 'jhstore' };
  }
  if (platform === 'limitededition') {
    const products = await fetchLimitedEditionCatalog(site, log);
    return { products, platform: 'limitededition' };
  }
  if (platform === 'foreverskin') {
    const products = await fetchForeverskinCatalog(fetchJson);
    return { products, platform: 'foreverskin' };
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
