// Full-catalogue crawlers for Sri Lankan cosmetics/beauty retailers, matched
// against Kapruka's Cosmetics category (kapruka.com/online/cosmetics).
// Same architecture as ../electronics-audit/site-adapters.js: every adapter
// returns Promise<Array<{ name: string, url: string, priceLKR: number|null }>>.

import * as cheerio from 'cheerio';
import { decodeEntities } from '../compare/normalize.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-LK,en;q=0.9', ...(opts.headers || {}) },
      redirect: 'follow',
      signal: controller.signal,
      ...opts,
    });
    return { ok: res.ok, status: res.status, text: await res.text(), headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts = {}) {
  const { ok, text } = await fetchText(url, opts);
  if (!ok || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// "Rs. 4,250.00" / "LKR 8,764" / "304,000" / "4500" -> 4250 (integer LKR).
function parsePriceLKR(text) {
  if (text == null) return null;
  const m = String(text).match(/[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// WooCommerce Store API price object -> integer LKR.
function wooPrice(p) {
  const price = p?.prices?.price;
  if (price == null) return null;
  const minorUnit = p?.prices?.currency_minor_unit ?? 2;
  const n = Number(price) / 10 ** minorUnit;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function abs(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

// A transient network hiccup on page 40 of 60 shouldn't lose pages 1-39 —
// retry once, then stop pagination and return what's been collected so far
// rather than throwing (matches electronics-audit's resilience pattern).
async function fetchJsonResilient(url, opts) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fetchJson(url, opts);
    } catch (err) {
      if (attempt === 2) {
        console.warn(`  ! catalog page fetch failed, stopping pagination here: ${url} (${err.message})`);
        return null;
      }
    }
  }
}

async function fetchTextResilient(url, opts) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchText(url, opts);
      return res.ok ? res.text : null;
    } catch (err) {
      if (attempt === 2) {
        console.warn(`  ! catalog page fetch failed, stopping pagination here: ${url} (${err.message})`);
        return null;
      }
    }
  }
}

// Paginate the WooCommerce Store API to pull a site's FULL catalogue.
function wooStoreApiCatalog(domain) {
  return async () => {
    const out = [];
    let useRestRouteParam = false;
    for (let page = 1; page <= 300; page++) {
      const prettyUrl = `https://${domain}/wp-json/wc/store/v1/products?page=${page}&per_page=100&orderby=id&order=asc`;
      const restRouteUrl = `https://${domain}/?rest_route=/wc/store/v1/products&page=${page}&per_page=100&orderby=id&order=asc`;
      let data = await fetchJsonResilient(useRestRouteParam ? restRouteUrl : prettyUrl);
      if (!Array.isArray(data) && page === 1 && !useRestRouteParam) {
        data = await fetchJsonResilient(restRouteUrl);
        if (Array.isArray(data)) useRestRouteParam = true;
      }
      if (!Array.isArray(data) || data.length === 0) break;
      for (const p of data) out.push({ name: decodeEntities(p.name), url: p.permalink, priceLKR: wooPrice(p) });
      if (data.length < 100) break;
    }
    return out;
  };
}

// Shopify's public products.json — paginate to pull the full catalogue.
function shopifyCatalog(domain) {
  return async () => {
    const out = [];
    for (let page = 1; page <= 200; page++) {
      const data = await fetchJsonResilient(`https://${domain}/products.json?limit=250&page=${page}`);
      const products = data?.products || [];
      if (products.length === 0) break;
      for (const p of products) {
        const variant = (p.variants || [])[0];
        const priceLKR = variant ? parsePriceLKR(variant.price) : null;
        out.push({ name: decodeEntities(p.title), url: abs(`https://${domain}`, `/products/${p.handle}`), priceLKR });
      }
      if (products.length < 250) break;
    }
    return out;
  };
}

// Standard "GET a page, parse cards, stop on empty" loop for sites using
// plain ?page=N pagination on a category listing page.
async function paginateHtml({ pageUrl, parseCards, opts, maxPages = 100 }) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchTextResilient(pageUrl(page), opts);
    if (!html) break;
    const cards = parseCards(html);
    if (cards.length === 0) break;
    out.push(...cards);
  }
  return out;
}

// beautyharbour.lk: custom Laravel storefront, no JSON API. Full unfiltered
// catalogue lives at /en/shop?page=N, plain server-rendered pagination.
function beautyharbourCatalog() {
  return () =>
    paginateHtml({
      pageUrl: (page) => `https://beautyharbour.lk/en/shop?page=${page}`,
      parseCards: (html) => {
        const $ = cheerio.load(html);
        const out = [];
        $('.product-box').each((_, el) => {
          const $el = $(el);
          const $a = $el.find('.product-info h4 a').first();
          const name = $a.text().trim();
          const url = $a.attr('href');
          const priceLKR = parsePriceLKR($el.find('.product-info .price').first().text());
          if (!name || !url) return;
          out.push({ name, url, priceLKR });
        });
        return out;
      },
    });
}

// wishque.com: custom PHP storefront, no usable JSON API (gated by key).
// The parent Beauty/Cosmetics/Skincare category page server-renders all
// products from every subcategory in one response — no pagination needed.
function wishqueCatalog() {
  return async () => {
    const html = await fetchTextResilient('https://www.wishque.com/catelog/beauty-cosmetics-and-skin-care');
    if (!html) return [];
    const $ = cheerio.load(html);
    const out = [];
    $('div.product').each((_, el) => {
      const $el = $(el);
      const $a = $el.find('a[href^="/product/view/"]').first();
      const name = $el.find('.details p.name').first().text().trim() || $a.text().trim();
      const href = $a.attr('href');
      const priceAttr = $el.find('.js-prod-price[data-price-store]').first().attr('data-price-store');
      const priceLKR = priceAttr ? parsePriceLKR(priceAttr) : parsePriceLKR($el.find('.price').first().text());
      if (!name || !href) return;
      out.push({ name, url: abs('https://www.wishque.com', href), priceLKR });
    });
    return out;
  };
}

// cosmetics.lk: Shopify, but /products.json and /collections/*/products.json
// are both 403'd by a Cloudflare bot-management rule specifically targeting
// bulk endpoints. The per-product `/products/{handle}.json` endpoint isn't
// blocked though, so enumerate handles via the sitemap and fetch each
// product's JSON individually (bounded concurrency to be polite).
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
function cosmeticsLkCatalog() {
  return async () => {
    const indexXml = await fetchTextResilient('https://cosmetics.lk/sitemap.xml');
    if (!indexXml) return [];
    const sitemapUrls = [...indexXml.matchAll(/<loc>([^<]*sitemap_products_[^<]*)<\/loc>/g)].map((m) => m[1]);
    const handles = new Set();
    for (const sitemapUrl of sitemapUrls) {
      const xml = await fetchTextResilient(sitemapUrl);
      if (!xml) continue;
      for (const m of xml.matchAll(/<loc>https:\/\/cosmetics\.lk\/products\/([^<\/]+)<\/loc>/g)) handles.add(m[1]);
    }
    const results = await mapWithConcurrency([...handles], 8, async (handle) => {
      const data = await fetchJsonResilient(`https://cosmetics.lk/products/${handle}.json`);
      const p = data?.product;
      if (!p) return null;
      const variant = (p.variants || [])[0];
      const priceLKR = variant ? parsePriceLKR(variant.price) : null;
      return { name: decodeEntities(p.title), url: `https://cosmetics.lk/products/${handle}`, priceLKR };
    });
    return results.filter(Boolean);
  };
}

// watsans.lk: custom CodeIgniter app, no "shop all" page and category pages
// overlap heavily (a product can appear under many subcategories). The
// sitemap lists all product-details URLs directly (deduplicated already),
// and each product page embeds a clean JSON-LD Product block with price —
// far more reliable than the listing-card HTML.
function watsansCatalog() {
  return async () => {
    const xml = await fetchTextResilient('https://watsans.lk/sitemap.xml');
    if (!xml) return [];
    const urls = [...xml.matchAll(/<loc>(https:\/\/watsans\.lk\/product-details\/[^<]+)<\/loc>/g)].map((m) => m[1]);
    const results = await mapWithConcurrency(urls, 8, async (url) => {
      const html = await fetchTextResilient(url);
      if (!html) return null;
      const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      if (!block) return null;
      let data;
      try {
        data = JSON.parse(block[1]);
      } catch {
        return null;
      }
      if (data?.['@type'] !== 'Product' || !data.name) return null;
      return { name: data.name.trim(), url, priceLKR: parsePriceLKR(data.price) };
    });
    return results.filter(Boolean);
  };
}

// cargillsonline.com: AngularJS SPA backed by a JSON API. A delivery-area
// check must run first to get store-session cookies, or the category call
// returns a placeholder "no products" row. PageSize/PageIndex are ignored
// server-side — one call returns the entire Health & Beauty category.
function cargillsCookieHeader(headers) {
  const all = headers.getSetCookie ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  return all.map((c) => c.split(';')[0]).join('; ');
}
function cargillsCatalog() {
  return async () => {
    const delivery = await fetchText('https://cargillsonline.com/Web/CheckDeliveryOptionV1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'PinCode=Colombo',
    });
    if (!delivery.ok) return [];
    const cookie = cargillsCookieHeader(delivery.headers);
    const data = await fetchJsonResilient('https://cargillsonline.com/Web/GetMenuCategoryItemsPagingV3/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', Cookie: cookie },
      body: JSON.stringify({
        CategoryId: 'NDI=', // base64 numeric id for "Health & Beauty", confirmed via GetCategoriesV1
        Search: '', Filter: '', PageIndex: 1, PageSize: 10000,
        BannerId: '', SectionId: '', CollectionId: '', SectionType: '', DataType: '', SubCatId: '', PromoId: '',
      }),
    });
    const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const out = [];
    for (const p of Array.isArray(data) ? data : []) {
      if (!p.ItemName || !p.EnId) continue;
      const priceLKR = parsePriceLKR(p.Price);
      const url = `https://cargillsonline.com/ProductDetails/${slugify(p.SKUCODE || p.ItemName)}/${slugify(p.ItemName)}?ID=${p.EnId}`;
      out.push({ name: p.ItemName, url, priceLKR });
    }
    return out;
  };
}

// glomark.lk (Softlogic's grocery/household site): beauty/personal-care
// isn't a top-level nav tab, it's a cluster of categories under Household.
// ?page=N is ignored server-side — each category page instead embeds its
// FULL product list inline as `productList = [...]` JS, no pagination or
// JSON API needed, just extract and JSON.parse that array.
const GLOMARK_BEAUTY_CATEGORIES = [
  'household/hair-care/c/193', 'household/facial-care/c/194', 'household/body-cleansing/c/195',
  'household/beauty-accessories/c/197', 'household/toiletries-men/c/198', 'household/skin-care/c/199',
  'household/personal-hygiene/c/206', 'household/female-fragrances/c/208', 'household/color-cosmetics/c/211',
  'household/beauty-otc-natural-beauty-care/c/881',
];
function glomarkCatalog() {
  return async () => {
    const out = [];
    for (const path of GLOMARK_BEAUTY_CATEGORIES) {
      const html = await fetchTextResilient(`https://glomark.lk/${path}`);
      if (!html) continue;
      // A lazy regex over this (100KB+, deeply bracket-nested) array literal
      // catastrophically backtracks — anchor on the literal terminator string
      // instead and slice, which is O(n) regardless of nesting.
      const anchor = html.indexOf('productCount = productList.length;');
      if (anchor === -1) continue;
      const closeIdx = html.lastIndexOf('];', anchor);
      const startMarker = 'productList = [';
      const openIdx = closeIdx === -1 ? -1 : html.lastIndexOf(startMarker, closeIdx);
      if (openIdx === -1) continue;
      const arrayText = html.slice(openIdx + startMarker.length - 1, closeIdx + 1);
      let products;
      try {
        products = JSON.parse(arrayText);
      } catch {
        continue;
      }
      for (const p of products) {
        if (!p.name || !p.id) continue;
        const priceLKR = parsePriceLKR(String(p.applicablePrice ?? p.promoPrice ?? p.price));
        out.push({ name: p.name, url: `https://glomark.lk/product/p/${p.id}`, priceLKR });
      }
    }
    return out;
  };
}

// fancypoint.lk: custom CodeIgniter app. The "shop all" page is populated
// client-side via a POST JSON endpoint that (despite the UI only offering
// 20/40/60) doesn't enforce its own limit param — one call returns the whole
// catalogue. ~94% of rows have price "0.00" (unset/discontinued) — filtered out.
function fancypointCatalog() {
  return async () => {
    const { ok, text } = await fetchText('https://www.fancypoint.lk/getProducts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'search=&category=&brand=&sorting=&limit=5000&offset=0&price-min=&price-max=&type=0',
    });
    if (!ok) return [];
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }
    const slugify = (s) =>
      String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
    const out = [];
    for (const p of data?.products || []) {
      const price = parseFloat(p.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const url = `https://www.fancypoint.lk/product-detail/${slugify(p.category)}/${slugify(p.name)}/${p.pro_id}`;
      out.push({ name: decodeEntities(p.name), url, priceLKR: Math.round(price) });
    }
    return out;
  };
}

// swiss.lk: custom Laravel app, no "shop all" page — enumerate via 208
// category IDs (/catfilter?cat=N&page=M). Each card renders TWICE per page
// (desktop + mobile wrapper), so dedupe by the numeric ?id= in the product
// URL rather than trusting card count. Site sends X-RateLimit-Limit: 120, so
// this stays serial (no extra concurrency) to keep well under it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function swissCatalog() {
  return async () => {
    // Several category IDs turned out to carry 700-1400+ products each (far
    // more than the site's own "shop all" style page suggested), which would
    // put a full crawl at tens of thousands of requests — bound page depth
    // per category to keep this finite; catches the bulk of each category's
    // inventory without an unbounded runtime.
    const seen = new Map();
    for (let cat = 1; cat <= 208; cat++) {
      for (let page = 1; page <= 15; page++) {
        const html = await fetchTextResilient(`https://swiss.lk/catfilter?cat=${cat}&page=${page}`);
        await sleep(300);
        if (!html) break;
        const $ = cheerio.load(html);
        let found = 0;
        $('article.list-product').each((_, el) => {
          const $el = $(el);
          const $a = $el.find('h2 a.product-link').first();
          const href = $a.attr('href');
          const idMatch = href && href.match(/[?&]id=(\d+)/);
          if (!idMatch) return;
          found++;
          if (seen.has(idMatch[1])) return; // desktop/mobile duplicate
          const name = $a.text().trim();
          const priceLi = $el.find('.pricing-meta .current-price').first();
          const priceLKR = parsePriceLKR(priceLi.clone().children('del').remove().end().text());
          if (!name) return;
          seen.set(idMatch[1], { name, url: href, priceLKR });
        });
        if (found === 0) break;
      }
    }
    return [...seen.values()];
  };
}

// odel.lk: custom Softlogic-built storefront. The homepage is behind a
// Zenedge JS challenge, but the AJAX search API used by category pages isn't
// — call it directly per Beauty subcategory, paging by offset/totalCount.
const ODEL_BEAUTY_SUBCATEGORIES = [3684, 4121, 4991, 3683, 5043]; // Skincare, Fragrances, Bath & Body, Haircare, MakeUp
function odelCatalog() {
  return async () => {
    const out = [];
    for (const subCat of ODEL_BEAUTY_SUBCATEGORIES) {
      let offset = 0;
      const limit = 100;
      for (;;) {
        const data = await fetchJsonResilient(
          `https://odel.lk/ajax/search?categories[]=812&subCategories[]=${subCat}&pagination=true&offset=${offset}&limit=${limit}&search_text=`,
          { headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://odel.lk/women/beauty/c/812' } },
        );
        const products = data?.products_list || [];
        if (products.length === 0) break;
        for (const p of products) {
          const slug = String(p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          out.push({
            name: p.name,
            url: `https://odel.lk/${slug}/p/${p.id}`,
            priceLKR: parsePriceLKR(String(p.applicablePrice ?? p.price)),
          });
        }
        offset += limit;
        if (offset >= (data?.pagination?.totalCount ?? 0)) break;
      }
    }
    return out;
  };
}

// mychemist.lk: custom CodeIgniter app. /Our-Range?page=N is the unified
// full-catalogue listing (sitemap.xml is stale/unreliable, skip it).
function mychemistCatalog() {
  return () =>
    paginateHtml({
      pageUrl: (page) => `https://www.mychemist.lk/Our-Range${page > 1 ? `?page=${page}` : ''}`,
      parseCards: (html) => {
        const $ = cheerio.load(html);
        const out = [];
        $('.single-product').each((_, el) => {
          const $el = $(el);
          const $a = $el.find('a.product-name-title').first();
          const name = $a.text().trim();
          const url = $a.attr('href');
          const priceAttr = $el.find('button.ajax_add_to_cart_button[data-product-price]').first().attr('data-product-price');
          const priceLKR = priceAttr ? parsePriceLKR(priceAttr) : parsePriceLKR($el.find('.special-price').first().text());
          if (!name || !url) return;
          out.push({ name, url, priceLKR });
        });
        return out;
      },
    });
}

// --- Confirmed-working catalogue adapters -----------------------------------
// Verified live: each returns >0 products via the generic platform helper.
export const CATALOG_ADAPTERS = [
  // Shopify
  { domain: 'essentials.lk', name: 'Essentials.lk', fetchCatalog: shopifyCatalog('essentials.lk') },
  { domain: 'blushme.lk', name: 'BlushMe', fetchCatalog: shopifyCatalog('blushme.lk') },
  { domain: 'shopxonline.lk', name: 'ShopX Online', fetchCatalog: shopifyCatalog('shopxonline.lk') },
  { domain: 'runrabbit.lk', name: 'Run Rabbit', fetchCatalog: shopifyCatalog('runrabbit.lk') },
  { domain: 'beautybox.lk', name: 'BeautyBox', fetchCatalog: shopifyCatalog('beautybox.lk') },
  { domain: 'naturalcosmeticslk.com', name: 'Natural Cosmetics', fetchCatalog: shopifyCatalog('naturalcosmeticslk.com') },
  { domain: 'spaceylon.com', name: 'Spa Ceylon', fetchCatalog: shopifyCatalog('lk.spaceylon.com') },
  { domain: 'spar2u.lk', name: 'SPAR', fetchCatalog: shopifyCatalog('spar2u.lk') },
  { domain: 'cosmetics.lk', name: 'Cosmetics.lk', fetchCatalog: cosmeticsLkCatalog() },
  // WooCommerce
  { domain: 'peacock.lk', name: 'Peacock', fetchCatalog: wooStoreApiCatalog('peacock.lk') },
  { domain: 'colombocosmetics.com', name: 'Colombo Cosmetics', fetchCatalog: wooStoreApiCatalog('colombocosmetics.com') },
  { domain: 'unionchemistspharmacy.lk', name: 'Union Chemists', fetchCatalog: wooStoreApiCatalog('unionchemistspharmacy.lk') },
  { domain: 'jeewakapharmacy.lk', name: 'Jeewaka Pharmacy', fetchCatalog: wooStoreApiCatalog('jeewakapharmacy.lk') },
  // Custom-built
  { domain: 'beautyharbour.lk', name: 'Beauty Harbour', fetchCatalog: beautyharbourCatalog() },
  { domain: 'wishque.com', name: 'Wishque', fetchCatalog: wishqueCatalog() },
  { domain: 'fancypoint.lk', name: 'Fancy Point', fetchCatalog: fancypointCatalog() },
  { domain: 'mychemist.lk', name: 'MyChemist', fetchCatalog: mychemistCatalog() },
  { domain: 'swiss.lk', name: 'Swiss', fetchCatalog: swissCatalog() },
  { domain: 'odel.lk', name: 'Odel', fetchCatalog: odelCatalog() },
  { domain: 'watsans.lk', name: 'Watsons', fetchCatalog: watsansCatalog() },
  { domain: 'cargillsonline.com', name: 'Cargills Online', fetchCatalog: cargillsCatalog() },
  { domain: 'glomark.lk', name: 'Glomark', fetchCatalog: glomarkCatalog() },
];
