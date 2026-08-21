// Crawls the full catalogue of each APPROVED-worthy discovered site into
// competitor_products, then marks it approved so it drops off the review
// queue (discovered-sites.html).
//
// Why this exists: a discovered site previously only ever contributed the
// single page a web search happened to surface (pipeline.js's
// processDiscovered scrapes exactly that URL). That makes the Price Checker
// only as good as the search engine's pick -- searching "Keto Peanut Spread
// 340g" surfaced *Herman* Peanut Butter pages on five different sites, so the
// checker compared against the wrong product while the right one
// ("Keto Nas Creamy Peanut Spread 340G") sat un-looked-at in the same shop.
// Caching each site's whole catalogue here lets checker/db-search.js match
// against every product a shop actually sells instead.
//
// Usage:
//   node src/tools/crawl-discovered-sites.js            # crawl + approve all pending
//   node src/tools/crawl-discovered-sites.js --dry      # report only, change nothing
//   node src/tools/crawl-discovered-sites.js --only=onlinekade.lk,chu.lk
//   node src/tools/crawl-discovered-sites.js --keep-pending   # crawl but don't approve

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { decodeEntities } from '../compare/normalize.js';
import {
  listDiscoveredSites,
  setDiscoveredSiteStatus,
  upsertCompetitorProducts,
  storageKind,
} from '../db.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which Price Checker category each site's products get filed under. These
// sites were all discovered through the general "Other" search path, so none
// carries a category of its own -- inferred here from what the shop actually
// sells (and the query that surfaced it). Anything not listed falls back to
// Grocery, which is what the bulk of these are.
const CATEGORY_BY_DOMAIN = {
  'cyberdeals.lk': 'Mobile Phones',      // surfaced by "Iphone 12 cover"
  'chu.lk': 'Cosmetics',                 // personal care / toiletries
  'kinderlandkidshop.com': 'Cosmetics',  // kids toiletries, same shelf as above
  'thechocolatehouse.lk': 'Chocolates',
  'chocolate.lk': 'Chocolates',
  'scentminis.lk': 'Perfume & Fragrance',  // surfaced by "Liquid Brun Eau De Parfum"
  'scentson.lk': 'Perfume & Fragrance',
  'nofake.lk': 'Perfume & Fragrance',
  'brandstore.lk': 'Perfume & Fragrance',
  'lifemobile.lk': 'Mobile Phones',        // surfaced by "Plokama ... Selfie Stick"
  'doctormobile.lk': 'Mobile Phones',
  'otc.lk': 'Mobile Phones',
  'toyo.lk': 'Mobile Phones',
  'baloon.lk': 'Mobile Phones',
  '37left.lk': 'Mobile Phones',
  'printercartridges.lk': 'Electronics',
};
const DEFAULT_CATEGORY = 'Grocery';

// A large sequential crawl (buyabans.com's id-discovery pass fetches 4000+
// pages one at a time) died silently for over an hour, stuck past both
// fetchJson's and fetchText's own AbortController timeout below -- aborting
// mid-response-body-read isn't always honoured (a known flaky spot in
// Node's fetch/undici), so a single stalled connection can hang the whole
// crawl forever even though the site is reachable again moments later.
// Racing every fetch against this independent plain setTimeout guarantees
// each one returns within ~31s no matter what the underlying fetch does,
// even if that means abandoning a socket that never got the memo.
function hardTimeout(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const attempt = (async () => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
      if (!res.ok) return null;
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([attempt, hardTimeout(16000)]);
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const attempt = (async () => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([attempt, hardTimeout(16000)]);
  } finally {
    clearTimeout(t);
  }
}

// Tracks consecutive fetch failures/timeouts within a sequential crawl loop
// and cools down when a run of them shows up, rather than hammering a site
// that's already pushing back. Found the hard way: buyabans.com silently
// stops answering (each request just running out the clock on the hard
// timeout above) once a crawl walks enough DISTINCT never-cached URLs in a
// row -- repeating the same handful of URLs never triggered it, so this
// reads as a WAF reacting to unique-path crawl behaviour specifically, not a
// simple per-request rate cap. It's a soft throttle that never returns an
// explicit 429/403, so there's no status code to react to, only the pattern
// of repeated nulls -- and it can take minutes to lift, hence the long cap.
function backoffTracker(log, label) {
  let consecutiveFails = 0;
  return async (result) => {
    if (result == null) {
      consecutiveFails++;
      if (consecutiveFails % 10 === 0) {
        const cooldownMs = Math.min(15000 * (consecutiveFails / 10), 300000);
        log(`  ${label}: ${consecutiveFails} consecutive failures -- cooling down ${Math.round(cooldownMs / 1000)}s`);
        await sleep(cooldownMs);
      }
    } else {
      consecutiveFails = 0;
    }
  };
}

function parsePriceLKR(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// WooCommerce Store API prices are integer strings scaled by minor unit.
function wooPrice(p) {
  const raw = p?.prices?.price;
  if (raw == null) return null;
  const minor = p.prices.currency_minor_unit ?? 2;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  const v = minor ? n / 10 ** minor : n;
  return v > 0 ? Math.round(v) : null;
}

async function wooCatalog(domain) {
  const out = [];
  let useRestRoute = false;
  for (let page = 1; page <= 300; page++) {
    const pretty = `https://${domain}/wp-json/wc/store/v1/products?page=${page}&per_page=100&orderby=id&order=asc`;
    const rest = `https://${domain}/?rest_route=/wc/store/v1/products&page=${page}&per_page=100&orderby=id&order=asc`;
    let data = await fetchJson(useRestRoute ? rest : pretty);
    if (!Array.isArray(data) && page === 1 && !useRestRoute) {
      data = await fetchJson(rest);
      if (Array.isArray(data)) useRestRoute = true;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const p of data) out.push({ name: decodeEntities(p.name), url: p.permalink, priceLKR: wooPrice(p) });
    if (data.length < 100) break;
    await sleep(250);
  }
  return out;
}

async function shopifyCatalog(domain) {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const data = await fetchJson(`https://${domain}/products.json?limit=250&page=${page}`);
    const products = data?.products || [];
    if (products.length === 0) break;
    for (const p of products) {
      const v = (p.variants || [])[0];
      out.push({
        name: decodeEntities(p.title),
        url: `https://${domain}/products/${p.handle}`,
        priceLKR: v ? parsePriceLKR(v.price) : null,
      });
    }
    if (products.length < 250) break;
    await sleep(250);
  }
  return out;
}

// OpenCart: no catalogue endpoint, but its search route spans every category.
// Union a few single-letter queries so a product missing one letter is still
// caught (same approach as the limitededition.lk partner adapter).
const OC_TERMS = ['a', 'e', 'i', 'o', 'u', 's'];

// Listing links carry the current paging state through (…&search=a&limit=100),
// so the same product reached from two different search terms would otherwise
// look like two products. Strip ONLY those paging params -- not the whole
// query string: OpenCart shops that haven't enabled SEO URLs identify the
// product itself in the query (index.php?route=product/product&product_id=N),
// so dropping it collapses the entire catalogue onto one URL.
const OC_PAGING_PARAMS = ['search', 'limit', 'page', 'sort', 'order'];
function stripOcPaging(href) {
  try {
    const u = new URL(href);
    for (const p of OC_PAGING_PARAMS) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return href;
  }
}

async function opencartCatalog(domain) {
  const byUrl = new Map();
  for (const term of OC_TERMS) {
    for (let page = 1; page <= 30; page++) {
      const html = await fetchText(
        `https://${domain}/index.php?route=product/search&search=${term}&limit=100&page=${page}`,
      );
      if (!html) break;
      const $ = cheerio.load(html);
      let found = 0;
      $('div.product-thumb, div.product-layout').each((_, el) => {
        const $c = $(el);
        const $a = $c.find('h4 a, .name a, .product-title a, .caption a').first();
        let href = $a.attr('href');
        if (!href) return;
        if (!href.startsWith('http')) href = new URL(href, `https://${domain}`).toString();
        href = stripOcPaging(href);
        found++;
        if (byUrl.has(href)) return;
        const $price = $c.find('.price').first();
        const $new = $price.find('.price-new').first();
        const priceLKR = parsePriceLKR(
          $new.length ? $new.text() : $price.clone().children().remove().end().text(),
        );
        const name = decodeEntities($a.text()).replace(/\s+/g, ' ').trim();
        if (!name) return;
        byUrl.set(href, { name, url: href, priceLKR });
      });
      if (found === 0) break;
      const shown = html.match(/Showing\s+\d+\s+to\s+(\d+)\s+of\s+(\d+)/i);
      if (shown && Number(shown[1]) >= Number(shown[2])) break;
      await sleep(350);
    }
  }
  return [...byUrl.values()];
}

// -- chu.lk -- custom Laravel storefront. Its own search endpoint
// (/search-product, JSON when sent X-Requested-With) looked like the way in,
// but it hard-caps at 35 results per query with no page param and no total
// count -- ten single-letter searches only ever turned up 100 distinct
// products out of a catalogue that goes far higher, so it can't be unioned
// into completeness the way limitededition.lk's OpenCart search could.
// /product/x/<id> resolves by id alone regardless of slug, and probing found
// ids densely populated (~100% hit rate sampled) from 1 up to the current
// max (~3998 as of writing) with a clean HTTP 500 past the end -- so plain
// sequential enumeration is actually the complete and reliable path here,
// unlike the search endpoint. Stops after a long run of consecutive misses
// (observed gap rate was ~0%, so a real run of misses reliably means "past
// the end", not "many deleted products").
const CHU_MAX_CONSECUTIVE_MISSES = 40;
const CHU_HARD_CAP = 20000; // safety backstop, well past any catalogue seen so far

async function fetchChuProduct(id, fetchTextFn) {
  const html = await fetchTextFn(`https://www.chu.lk/product/x/${id}`);
  if (html == null) return null;
  const $ = cheerio.load(html);
  const name = decodeEntities($('title').first().text()).replace(/\s+/g, ' ').trim();
  // The page carries TWO .current-price spans -- an empty template
  // placeholder first, the actual price second -- so .first() silently grabs
  // the blank one. Take the first one that actually has text instead.
  let price = null;
  $('.current-price').each((_, el) => {
    if (price != null) return;
    const p = parsePriceLKR($(el).text());
    if (p != null) price = p;
  });
  if (!name || price == null) return null;
  return { name, price };
}

async function chuCatalog(log = () => {}) {
  // About 1 in 13 ids returns HTTP 500 -- confirmed by repeated re-fetching
  // that it's the SAME ids failing every time (11, 13, 17, 27, ...), not
  // random transient flakiness, so these are permanently broken product
  // records on their end, not gaps worth waiting out. One retry only to
  // absorb a genuine network blip; scattered (not clustered) so they never
  // approach the consecutive-miss cutoff below.
  const fetchTextFn = async (url) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Referer: 'https://www.chu.lk/' },
        });
        if (res.status === 200) return await res.text();
        return null;
      } catch {
        if (attempt === 2) return null;
        await sleep(600);
      }
    }
    return null;
  };

  const out = [];
  let misses = 0;
  for (let id = 1; id <= CHU_HARD_CAP; id++) {
    const p = await fetchChuProduct(id, fetchTextFn);
    if (p) {
      out.push({ name: p.name, url: `https://www.chu.lk/product/x/${id}`, priceLKR: p.price });
      misses = 0;
    } else {
      misses++;
      if (misses >= CHU_MAX_CONSECUTIVE_MISSES) break;
    }
    if (id % 500 === 0) log(`  partner (chu) id ${id}: ${out.length} found so far`);
    await sleep(120);
  }
  return out;
}

// -- glomark.lk -- custom PHP/jQuery storefront (Softlogic's online
// supermarket) with no REST catalogue endpoint, but /search?searchText=<term>
// server-renders a `productList = [{...}, ...]` JSON array straight into the
// page -- the exact data the page's own JS uses to paint results, just
// easier to read as JSON than to scrape from HTML. Confirmed (by diffing
// result counts across every letter in OC_TERMS) that searchText doesn't
// actually filter the array server-side -- every single-letter query came
// back with the exact same 5596 products, so this is really "get whole
// catalogue" wearing a search endpoint's clothes. One request is enough;
// unioning terms like the OpenCart adapter does would just refetch identical
// data 6x. There's no per-product detail page (browsing is search-and-add-
// to-cart only, no product URL to link to), so the stored `url` deep-links
// back to a search for the product's own name -- not perfect, but it at
// least lands a human on the right item.
function extractBalancedJsonArray(text, startIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

async function glomarkCatalog(log = () => {}) {
  const html = await fetchText('https://glomark.lk/search?searchText=a');
  if (!html) return [];
  // The page also declares `let productList = [];` as an empty template
  // before the real, populated reassignment further down -- searching for
  // the marker followed by an actual product object skips straight to it.
  const marker = 'productList = [{"id"';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return [];
  const arrStart = markerIdx + marker.indexOf('[');
  const jsonText = extractBalancedJsonArray(html, arrStart);
  if (!jsonText) return [];
  let arr;
  try {
    arr = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const byId = new Map();
  for (const p of arr) {
    if (byId.has(p.id)) continue;
    const name = decodeEntities(String(p.name || '')).replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const price = Number(p.applicablePrice ?? p.promoPrice ?? p.price);
    byId.set(p.id, {
      name,
      url: `https://glomark.lk/search?searchText=${encodeURIComponent(name)}`,
      priceLKR: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
    });
  }
  log(`  glomark.lk: ${byId.size} products`);
  return [...byId.values()];
}

// -- keellssuper.com -- React SPA backed by a session-gated JSON API
// (zebraliveback.keellssuper.com), found by watching the site's own network
// traffic in a headless browser rather than static analysis -- the app code
// calling it lives in a lazily-loaded chunk grep never sees. GuestLogin
// hands back a `userSessionID` that every following call must echo back in a
// `usersessionid` header (paired with the cf-mitigation cookies GuestLogin's
// response sets -- without both together the API 401s). GetItemDetails with
// an empty `itemDescription` and no department/category filters returns the
// FULL catalogue, paginated (itemsPerPage caps out around 500/page).
const KEELLS_API_BASE = 'https://zebraliveback.keellssuper.com';
const KEELLS_HEADERS_BASE = {
  'User-Agent': UA,
  Accept: 'application/json',
  Referer: 'https://keellssuper.com/',
};

function mergeSetCookies(jar, res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  for (const line of setCookies) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function keellsCatalog(log = () => {}) {
  const cookieJar = new Map();
  const cookieHeader = () => [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');

  const loginRes = await fetch(`${KEELLS_API_BASE}/1.0/Login/GuestLogin`, {
    method: 'POST',
    headers: KEELLS_HEADERS_BASE,
  }).catch(() => null);
  if (!loginRes || !loginRes.ok) return [];
  mergeSetCookies(cookieJar, loginRes);
  const loginData = await loginRes.json().catch(() => null);
  const sessionId = loginData?.result?.userSessionID;
  if (!sessionId) return [];

  const out = [];
  const perPage = 500;
  let pageCount = 1;
  for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
    const qs = new URLSearchParams({
      pageNo: String(pageNo),
      itemsPerPage: String(perPage),
      outletCode: 'SCDR',
      departmentId: '',
      subDepartmentId: '',
      categoryId: '',
      itemDescription: '',
      itemPricefrom: '0',
      itemPriceTo: '999999',
      isFeatured: '0',
      isPromotionOnly: 'false',
      promotionCategory: '',
      sortBy: 'default',
      BrandId: '',
      storeName: '',
      subDeaprtmentCode: '',
      isShowOutofStockItems: 'true',
      brandName: '',
    });
    const res = await fetch(`${KEELLS_API_BASE}/2.0/WebV2/GetItemDetails?${qs}`, {
      headers: { ...KEELLS_HEADERS_BASE, usersessionid: sessionId, Cookie: cookieHeader() },
    }).catch(() => null);
    if (!res || !res.ok) break;
    mergeSetCookies(cookieJar, res);
    const data = await res.json().catch(() => null);
    const result = data?.result?.itemDetailResult;
    if (!result) break;
    pageCount = result.pageCount || pageCount;
    for (const it of result.itemDetails || []) {
      const name = String(it.name || '').trim();
      if (!name || name === '#N/A') continue; // a handful of delisted/placeholder rows
      const price = Number(it.amount);
      out.push({
        name,
        url: `https://keellssuper.com/productDetail?itemcode=${it.itemCode}`,
        priceLKR: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
      });
    }
    log(`  keellssuper.com page ${pageNo}/${pageCount}: ${result.itemDetails?.length || 0} items, total ${out.length}`);
    await sleep(300);
  }
  return out;
}

// -- buyabans.com -- custom Laravel/Vue storefront (Abans' online store).
// /product-list?category_id=N returns an HTML fragment (not the full page)
// for that one category -- clean and cheap once you have the id, but there's
// no single endpoint listing either the whole catalogue or the full category
// tree with ids: the homepage's embedded `categorySet0..4` arrays are only
// the ~18 top-level megamenu entries, not the ~4000+ nested leaf categories
// visible in sitemap.xml. Each leaf category page DOES embed its own numeric
// id inline (`requestParams.push('category_id=207')`), so the only reliable
// way to discover every id is to fetch every sitemap URL once and read it
// off the page. That's thousands of page fetches just for id discovery,
// before the (cheaper) per-category product-list calls -- there's no
// shortcut here, it really is that heavy for this particular site. Both
// loops run deliberately slowly (seconds, not milliseconds, between
// requests) with backoffTracker() on top -- confirmed the site's WAF starts
// silently throttling once enough distinct new URLs get hit in a row, so a
// full crawl here is a genuinely long-running, patient operation, not a
// bug to optimise away.
const BUYABANS_CATEGORY_ID_RE = /requestParams\.push\('category_id=(\d+)'\)/;

async function buyabansSitemapUrls() {
  const xml = await fetchText('https://buyabans.com/sitemap.xml');
  if (!xml) return [];
  const urls = [...xml.matchAll(/<loc>(https:\/\/buyabans\.com\/[^<]+)<\/loc>/g)].map((m) => m[1]);
  return [...new Set(urls)];
}

async function buyabansCategoryIds(log = () => {}) {
  const urls = await buyabansSitemapUrls();
  const ids = new Map(); // id -> a url_path, for logging only
  const track = backoffTracker(log, 'buyabans.com id discovery');
  let checked = 0;
  for (const url of urls) {
    const html = await fetchText(url);
    await track(html);
    checked++;
    if (html) {
      const m = html.match(BUYABANS_CATEGORY_ID_RE);
      if (m && !ids.has(m[1])) ids.set(m[1], url);
    }
    if (checked % 200 === 0) log(`  buyabans.com id discovery: ${checked}/${urls.length} pages checked, ${ids.size} category ids found`);
    await sleep(1500);
  }
  log(`  buyabans.com id discovery done: ${ids.size} category ids from ${urls.length} sitemap pages`);
  return [...ids.keys()];
}

async function buyabansCatalog(log = () => {}) {
  const ids = await buyabansCategoryIds(log);
  const byUrl = new Map();
  const track = backoffTracker(log, 'buyabans.com product-list');
  let done = 0;
  for (const id of ids) {
    const qs = new URLSearchParams({
      category_id: id,
      stamp_banner_id: '0',
      sort: 'new_arrivals',
      is_search_list: 'false',
      aging_only: '0',
    });
    const data = await fetchJson(`https://buyabans.com/product-list?${qs}`);
    await track(data);
    done++;
    const html = data?.html;
    if (html) {
      const $ = cheerio.load(html);
      $('.product-list-item').each((_, el) => {
        const $item = $(el);
        const href = $item.find('a[href^="https://buyabans.com/"]').first().attr('href');
        if (!href || byUrl.has(href)) return;
        const name = decodeEntities($item.find('.pro-name-compact').first().text()).replace(/\s+/g, ' ').trim();
        if (!name) return;
        const priceText = $item.find('.selling-price').first().text() || $item.find('.market-price').first().text();
        const priceLKR = parsePriceLKR(priceText);
        byUrl.set(href, { name, url: href, priceLKR });
      });
    }
    if (done % 100 === 0) log(`  buyabans.com product-list: ${done}/${ids.length} categories, ${byUrl.size} products so far`);
    await sleep(1000);
  }
  log(`  buyabans.com: ${byUrl.size} products from ${ids.length} categories`);
  return [...byUrl.values()];
}

// Domains that need bespoke handling rather than platform auto-detection.
const SITE_SPECIFIC_CRAWLERS = {
  'chu.lk': async (log) => ({ products: await chuCatalog(log), platform: 'chu-custom' }),
  'glomark.lk': async (log) => ({ products: await glomarkCatalog(log), platform: 'glomark-custom' }),
  'keellssuper.com': async (log) => ({ products: await keellsCatalog(log), platform: 'keells-custom' }),
  'buyabans.com': async (log) => ({ products: await buyabansCatalog(log), platform: 'buyabans-custom' }),
};

// Try each known platform in turn. Ordered cheapest-first: the two JSON APIs
// are a single request to disprove, the OpenCart path costs many.
async function crawlSite(domain, log = () => {}) {
  if (SITE_SPECIFIC_CRAWLERS[domain]) return SITE_SPECIFIC_CRAWLERS[domain](log);

  const woo = await wooCatalog(domain);
  if (woo.length) return { products: woo, platform: 'woocommerce' };

  const shop = await shopifyCatalog(domain);
  if (shop.length) return { products: shop, platform: 'shopify' };

  const home = await fetchText(`https://${domain}/`);
  if (home && /opencart|route=product/i.test(home)) {
    const oc = await opencartCatalog(domain);
    if (oc.length) return { products: oc, platform: 'opencart' };
  }
  return { products: [], platform: null };
}

async function main() {
  const dry = process.argv.includes('--dry');
  const keepPending = process.argv.includes('--keep-pending');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null;

  console.log(`Storage backend: ${storageKind}${dry ? '  [DRY RUN]' : ''}`);
  // Naming a site explicitly means "crawl this one", so look past the pending
  // filter -- otherwise a site already approved (possibly with a bad partial
  // catalogue) could never be re-crawled through this tool.
  let pending = only
    ? (await listDiscoveredSites()).filter((d) => only.has(d.domain))
    : await listDiscoveredSites('pending');
  console.log(`Crawling ${pending.length} discovered site(s)…\n`);

  let approved = 0;
  let skipped = 0;
  let totalProducts = 0;

  for (const site of pending) {
    const category = CATEGORY_BY_DOMAIN[site.domain] || DEFAULT_CATEGORY;
    process.stdout.write(`${site.domain} [${category}] … `);
    if (SITE_SPECIFIC_CRAWLERS[site.domain]) process.stdout.write('\n');
    let result;
    try {
      result = await crawlSite(site.domain, (m) => console.log(m));
    } catch (err) {
      console.log(`FAILED: ${err.message.slice(0, 70)}`);
      skipped++;
      continue;
    }
    const { products, platform } = result;
    const priced = products.filter((p) => p.priceLKR != null);
    if (products.length === 0) {
      // Left pending on purpose: no catalogue means nothing to approve, and
      // it stays on the review queue for a human to look at by hand.
      console.log('no catalogue found — left pending');
      skipped++;
      continue;
    }
    console.log(`${products.length} products (${priced.length} priced) via ${platform}`);
    totalProducts += products.length;

    if (dry) continue;
    try {
      await upsertCompetitorProducts(
        site.domain,
        products.map((p) => ({ ...p, siteName: site.domain })),
        category,
      );
      if (!keepPending) {
        await setDiscoveredSiteStatus(site.id, 'approved');
        approved++;
      }
    } catch (err) {
      console.log(`  ! save failed: ${err.message.slice(0, 90)}`);
      skipped++;
    }
  }

  console.log(
    `\nDone — ${totalProducts} products cached, ${approved} site(s) approved, ${skipped} skipped/left pending.`,
  );
}

main().catch((err) => {
  console.error('Crawl failed:', err);
  process.exitCode = 1;
});
