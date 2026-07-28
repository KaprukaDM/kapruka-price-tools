// Scrapes a Kapruka international gifts catalog, e.g.
// https://www.kapruka.com/online/UAE — the same page shape is used for every
// destination country (just swap the country code), so this scraper is
// shared across all countries in the International Gifting Price Checker.
// Each product card embeds a JSON-LD Product block — same technique already
// proven in kapruka-relevancy-python/bulk.py and src/compare/sources.js.
// Pagination is discovered from the page's own paginate('...') JS call rather
// than assumed, since Kapruka listing pages vary in query-param shape.

import * as cheerio from 'cheerio';

const PAGE_SAFETY_CAP = 10;

// Kapruka geolocates prices by the real connecting IP — a server hosted
// outside Sri Lanka can see USD instead of LKR. Set SCRAPE_PROXY to a Sri
// Lankan-exit HTTP(S) proxy to force LKR pricing (same convention as
// src/compare/sources.js). Left blank, requests go direct.
const SCRAPE_PROXY = process.env.SCRAPE_PROXY || '';
let proxyDispatcher;

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-LK,en;q=0.9',
};

async function fetchHtml(url, referer) {
  const headers = { ...UA };
  if (referer) {
    headers.Referer = referer;
    headers['X-Requested-With'] = 'XMLHttpRequest';
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const opts = { headers, redirect: 'follow', signal: controller.signal };
  if (SCRAPE_PROXY) {
    if (!proxyDispatcher) {
      const { ProxyAgent } = await import('undici');
      proxyDispatcher = new ProxyAgent(SCRAPE_PROXY);
    }
    opts.dispatcher = proxyDispatcher;
  }
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function skuFromUrl(url) {
  const m = url && url.match(/\/kid\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : url;
}

function parseListingProducts(html) {
  const $ = cheerio.load(html);
  const products = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      if (!node || node['@type'] !== 'Product') continue;
      const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
      const image = Array.isArray(node.image) ? node.image[0] : node.image;
      const price = offers.price != null ? Number(offers.price) : null;
      const url = node.url || null;
      if (!url || price == null) continue;
      products.push({
        sku: skuFromUrl(url),
        name: node.name || null,
        url,
        image: image || null,
        priceLKR: price,
        currency: offers.priceCurrency || 'LKR',
      });
    }
  });
  return products;
}

function findPaginationTemplate(html, baseUrl) {
  const m = html.match(/paginate\('([^']+)'\)/);
  if (!m) return null;
  return new URL(m[1], baseUrl).toString();
}

function withPage(templateUrl, page) {
  const u = new URL(templateUrl);
  u.searchParams.set('p', String(page));
  return u.toString();
}

// Fetch every product on a Kapruka country listing (e.g. country="UAE" ->
// kapruka.com/online/UAE), following pagination until the page count is
// exhausted or a page yields nothing new.
export async function fetchKaprukaCountryCatalog(country) {
  const listingUrl = `https://www.kapruka.com/online/${encodeURIComponent(country)}`;
  const seen = new Map();
  const firstHtml = await fetchHtml(listingUrl);
  for (const p of parseListingProducts(firstHtml)) seen.set(p.url, p);

  const template = findPaginationTemplate(firstHtml, listingUrl);
  let page = 2;
  while (template && page <= PAGE_SAFETY_CAP) {
    const pageUrl = withPage(template, page);
    let pageHtml;
    try {
      pageHtml = await fetchHtml(pageUrl, listingUrl);
    } catch {
      break;
    }
    const before = seen.size;
    for (const p of parseListingProducts(pageHtml)) seen.set(p.url, p);
    if (seen.size === before) break;
    page += 1;
  }

  return [...seen.values()];
}
