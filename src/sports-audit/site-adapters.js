// Full-catalogue crawlers for Sri Lankan sports/fitness retailers, matched
// against Kapruka's Sports category (kapruka.com/online/sports).
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
  { domain: 'cleats.lk', name: 'Cleats.lk', fetchCatalog: shopifyCatalog('cleats.lk') },
  { domain: 'vecno.lk', name: 'Vecno', fetchCatalog: shopifyCatalog('vecno.lk') },
  { domain: 'eliteshuttler.com', name: 'Elite Shuttler', fetchCatalog: shopifyCatalog('eliteshuttler.com') },
  { domain: 'boltgear.com', name: 'Bolt Gear', fetchCatalog: shopifyCatalog('boltgear.com') },
  { domain: 'foaclothing.com', name: 'FOA Clothing', fetchCatalog: shopifyCatalog('foaclothing.com') },
  // WooCommerce
  { domain: 'kasports.lk', name: 'KA Sports', fetchCatalog: wooStoreApiCatalog('kasports.lk') },
  { domain: 'quantum.lk', name: 'Quantum Fitness', fetchCatalog: wooStoreApiCatalog('quantum.lk') },
  { domain: 'adventurehub.lk', name: 'Adventure Hub', fetchCatalog: wooStoreApiCatalog('adventurehub.lk') },
  { domain: 'infinitypoint.lk', name: 'Infinity Point', fetchCatalog: wooStoreApiCatalog('infinitypoint.lk') },
  { domain: 'campingmastersl.com', name: 'Camping Master', fetchCatalog: wooStoreApiCatalog('campingmastersl.com') },
  { domain: 'gooutdoors.lk', name: 'Go Outdoors', fetchCatalog: wooStoreApiCatalog('gooutdoors.lk') },
  { domain: 'shoeshubonline.lk', name: 'Shoes Hub', fetchCatalog: wooStoreApiCatalog('shoeshubonline.lk') },
  { domain: 'dsifootcandy.lk', name: 'DSI Footcandy', fetchCatalog: wooStoreApiCatalog('dsifootcandy.lk') },
  { domain: 'avi.lk', name: 'AVI', fetchCatalog: wooStoreApiCatalog('avi.lk') },
  { domain: 'thecricketshoplk.com', name: 'The Cricket Shop', fetchCatalog: wooStoreApiCatalog('thecricketshoplk.com') },
];

// mysports.lk, tentmaster.lk (WooCommerce Store REST API not enabled — would
// need bespoke HTML scraping), trinitysports.lk, sportszone.lk,
// sugathcycle.lk, bigdeals.lk, ranjanlanka.lk, odel.lk, singersl.com,
// mysoftlogic.lk, myarpico.com (custom-built, need bespoke adapters),
// decathlon.lk (SSL/DNS issue on fetch) are not yet wired up.
