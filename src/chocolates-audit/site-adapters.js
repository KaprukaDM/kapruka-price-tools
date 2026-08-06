// Full-catalogue crawlers for Sri Lankan chocolate/confectionery/gifting
// retailers, matched against Kapruka's Chocolates category
// (kapruka.com/online/chocolates). Same architecture as
// ../electronics-audit/site-adapters.js.

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

function parsePriceLKR(text) {
  if (text == null) return null;
  const m = String(text).match(/[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

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

// glomark.lk: ?page=N is ignored server-side — each category page instead
// embeds its FULL product list inline as `productList = [...]` JS. Same
// pattern discovered for its Beauty category (see cosmetics-audit).
function glomarkChocolateCatalog() {
  return async () => {
    const html = await fetchTextResilient('https://glomark.lk/Grocery/Confectionary/Chocolate/sc/845');
    if (!html) return [];
    const anchor = html.indexOf('productCount = productList.length;');
    if (anchor === -1) return [];
    const closeIdx = html.lastIndexOf('];', anchor);
    const startMarker = 'productList = [';
    const openIdx = closeIdx === -1 ? -1 : html.lastIndexOf(startMarker, closeIdx);
    if (openIdx === -1) return [];
    const arrayText = html.slice(openIdx + startMarker.length - 1, closeIdx + 1);
    let products;
    try {
      products = JSON.parse(arrayText);
    } catch {
      return [];
    }
    const out = [];
    for (const p of products) {
      if (!p.name || !p.id) continue;
      const priceLKR = parsePriceLKR(String(p.applicablePrice ?? p.promoPrice ?? p.price));
      out.push({ name: p.name, url: `https://glomark.lk/product/p/${p.id}`, priceLKR });
    }
    return out;
  };
}

// wishque.com: the parent Chocolates & Sweets category page server-renders
// every product across every subcategory in one response — no pagination
// needed. Same platform/markup discovered for its Beauty category.
function wishqueChocolateCatalog() {
  return async () => {
    const html = await fetchTextResilient('https://www.wishque.com/catelog/chocolates-and-sweets');
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

// srigift.com: custom ASP.NET site — products load via a plain POST JSON
// AJAX endpoint (the shell HTML has no product data at all), 10/page.
function srigiftChocolateCatalog() {
  return async () => {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const data = await fetchJsonResilient(
        `https://srigift.com/ajax/SelectItemPageItems?category=chocolates&subcategory=all-areas&search=&page=${page}&isHomePage=`,
        { method: 'POST' },
      );
      if (!Array.isArray(data) || data.length === 0) break;
      for (const p of data) {
        if (!p.FullName || !p.ItemPageURL) continue;
        out.push({ name: p.FullName, url: abs('https://srigift.com', p.ItemPageURL), priceLKR: parsePriceLKR(String(p.UnitPrice)) });
      }
      if (data.length < 10) break;
    }
    return out;
  };
}

// lankangift.com: OpenCart, server-rendered. limit=999 forces the whole
// category onto one page regardless of size.
function lankangiftChocolateCatalog() {
  return async () => {
    const html = await fetchTextResilient('https://lankangift.com/index.php?route=product/category&path=277&limit=999');
    if (!html) return [];
    const $ = cheerio.load(html);
    const out = [];
    $('div.product-layout.product-list').each((_, el) => {
      const $el = $(el);
      const $a = $el.find('h2.product-name > a').first();
      const name = $a.text().trim();
      const href = $a.attr('href');
      const priceLKR = parsePriceLKR($el.find('.price-box .regular-price .price, .price-box .special-price .price').first().text());
      if (!name || !href) return;
      out.push({ name, url: href, priceLKR });
    });
    return out;
  };
}

// lassana.com: React SPA, no server-rendered HTML at all — everything comes
// from api.lassana.com's JSON API. Chocolates & Cookies (categoryId=9) has
// two subcategories that both need enumerating; 10 products/page, empty
// array signals the last page.
const LASSANA_CHOCOLATE_SUBCATEGORIES = [47, 122]; // La Treats Chocolates, Gerard Mendis Chocolatier
function lassanaChocolateCatalog() {
  return async () => {
    const out = [];
    for (const subCategoryId of LASSANA_CHOCOLATE_SUBCATEGORIES) {
      for (let pageNo = 1; pageNo <= 50; pageNo++) {
        const data = await fetchJsonResilient(
          `https://api.lassana.com/api/v2/product/active/findByCategory?categoryId=9&subCategoryId=${subCategoryId}&subCategory2Id=0&subCategory3Id=0&pageNo=${pageNo}`,
        );
        const products = data?.products || [];
        if (products.length === 0) break;
        for (const p of products) {
          if (!p.productName || !p.id) continue;
          // discountedPrice is 0 (not null) when nothing's on sale, so ?? alone
          // would wrongly pick it over the real sellingPriceLk.
          const priceLKR = parsePriceLKR(String(p.discountedPrice || p.sellingPriceLk));
          out.push({ name: p.productName, url: `https://lassana.com/product/${p.id}`, priceLKR });
        }
      }
    }
    return out;
  };
}

// --- Confirmed-working catalogue adapters -----------------------------------
export const CATALOG_ADAPTERS = [
  // WooCommerce
  { domain: 'thechocolatehouse.lk', name: 'The Chocolate House', fetchCatalog: wooStoreApiCatalog('thechocolatehouse.lk') },
  { domain: 'chocolate.lk', name: 'Chocolate.lk', fetchCatalog: wooStoreApiCatalog('chocolate.lk') },
  { domain: 'treatsnstuff.com', name: 'Treats N Stuff', fetchCatalog: wooStoreApiCatalog('treatsnstuff.com') },
  { domain: 'giftme.lk', name: 'GiftMe', fetchCatalog: wooStoreApiCatalog('giftme.lk') },
  // Shopify
  { domain: 'luxecolombo.com', name: 'Luxe Colombo', fetchCatalog: shopifyCatalog('luxecolombo.com') },
  // Custom-built
  { domain: 'glomark.lk', name: 'Glomark', fetchCatalog: glomarkChocolateCatalog() },
  { domain: 'wishque.com', name: 'Wishque', fetchCatalog: wishqueChocolateCatalog() },
  { domain: 'srigift.com', name: 'SriGift', fetchCatalog: srigiftChocolateCatalog() },
  { domain: 'lankangift.com', name: 'Lankan Gift', fetchCatalog: lankangiftChocolateCatalog() },
  { domain: 'lassana.com', name: 'Lassana Chocolates', fetchCatalog: lassanaChocolateCatalog() },
];

// srigift.com, lankangift.com, lassana.com, myravana.lk, lakwimana.com,
// silveraisle.com, onlinekade.lk, kandos.lk, arpicosupercentre.com,
// keellssuper.com (JS-rendered), cargillsonline.com are not yet wired up.
// daraz.lk (large marketplace, heavy third-party-seller noise) deliberately
// excluded, same call as for cosmetics/sports.
