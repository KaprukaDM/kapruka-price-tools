// Full-catalogue crawlers for Sri Lankan home & lifestyle retailers, matched
// against Kapruka's Home & Lifestyle category (kapruka.com/online/home_lifestyle).
// Same architecture as ../electronics-audit/site-adapters.js.

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

// --- Confirmed-working catalogue adapters -----------------------------------
export const CATALOG_ADAPTERS = [
  // Shopify
  { domain: 'yourhomefurniture.lk', name: 'Your Home Furniture', fetchCatalog: shopifyCatalog('yourhomefurniture.lk') },
  { domain: 'home47.shop', name: 'Home47', fetchCatalog: shopifyCatalog('home47.shop') },
  { domain: 'edys.lk', name: 'Edys', fetchCatalog: shopifyCatalog('edys.lk') },
  { domain: 'kitchenwarehouse.lk', name: 'Kitchen Warehouse', fetchCatalog: shopifyCatalog('kitchenwarehouse.lk') },
  { domain: 'houseoffashions.lk', name: 'House of Fashions', fetchCatalog: shopifyCatalog('houseoffashions.lk') },
  { domain: 'urbanisland.lk', name: 'Urban Island', fetchCatalog: shopifyCatalog('urbanisland.lk') },
  { domain: 'finez.lk', name: 'Finez Interiors', fetchCatalog: shopifyCatalog('finez.lk') },
  { domain: 'linencollection.com', name: 'Linen Collection', fetchCatalog: shopifyCatalog('linencollection.com') },
  { domain: 'agc.lk', name: 'AGC The Concept Store', fetchCatalog: shopifyCatalog('agc.lk') },
  // WooCommerce
  { domain: 'pettahkade.lk', name: 'Pettah Kade', fetchCatalog: wooStoreApiCatalog('pettahkade.lk') },
  { domain: 'kitchenstuff.lk', name: 'Kitchen Stuff', fetchCatalog: wooStoreApiCatalog('kitchenstuff.lk') },
  { domain: 'nilkamal.lk', name: 'Nilkamal Eswaran', fetchCatalog: wooStoreApiCatalog('nilkamal.lk') },
  { domain: 'elya.lk', name: 'Elya', fetchCatalog: wooStoreApiCatalog('elya.lk') },
  { domain: 'trendyhomes.lk', name: 'Trendy Homes', fetchCatalog: wooStoreApiCatalog('trendyhomes.lk') },
  { domain: 'seasonslinen.com', name: 'Seasons Linen', fetchCatalog: wooStoreApiCatalog('seasonslinen.com') },
  { domain: 'thebedsheetfactory.com', name: 'The Bedsheet Factory', fetchCatalog: wooStoreApiCatalog('thebedsheetfactory.com') },
  { domain: 'plantme.lk', name: 'PlantMe', fetchCatalog: wooStoreApiCatalog('plantme.lk') },
  { domain: 'megadeals.lk', name: 'Mega Deals', fetchCatalog: wooStoreApiCatalog('megadeals.lk') },
];

// damro.lk, myarpico.com, catchme.lk, keellssuper.com, bamagate.com,
// wow.lk/wowmall.lk (403'd/blocked on automated fetch), buyabans.com,
// mysoftlogic.lk, singersl.com, odel.lk, glomark.lk, nolimit.lk (custom-built,
// need bespoke adapters), agrlk.com (Magento, unexplored) are not yet wired
// up. Also see ../electronics-audit and ../cosmetics-audit CATALOG_ADAPTERS —
// several of those sites (wasi.lk, dinapalagroup.lk, celltronics.lk) sell
// unfiltered full catalogues that already include home/lifestyle products,
// reused directly by match-local.js without a fresh crawl.
