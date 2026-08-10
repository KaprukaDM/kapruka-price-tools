// Scrapes fnp.ae category listing pages to build a candidate catalog for
// auto-matching against Kapruka's UAE products. This bulk crawl only covers
// the categories that plausibly cover Kapruka's UAE assortment (hampers,
// combos, flowers, cakes, chocolates, branded gifts), and only their first
// page, so it's a coverage sample, not the full site — products that don't
// land on one of those first pages are matched instead via searchFnpProducts
// below (see engine.js's per-product search fallback).
//
// Each category/search page server-renders its product cards as
// <li class="h-product" data-product-id="..." data-url="..."> with the name,
// price (AED), currency and image as itemprop meta tags underneath — no JS
// rendering needed.

import * as cheerio from 'cheerio';

const CATEGORIES = [
  'gift-hampers',
  'combos',
  'cakes',
  'chocolates',
  'flower-bouquets',
  'flowers',
  'personalised-gifts',
  'gifts-bestsellers',
  'branded-gifts',
];

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-AE,en;q=0.9',
};

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { headers: UA, redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// fnp.ae uses (at least) two different card templates across categories:
//   1. <li class="h-product" data-product-id="..." data-url="...">  (gift-hampers, combos, ...)
//      — has itemprop meta tags for price/currency.
//   2. <div class="product" data-id="..."><a href="...">            (cakes, ...)
//      — price is plain text after a WebRupee span, no explicit currency
//        (fnp.ae's UAE catalog is always AED).
function parseCategoryProducts(html) {
  const $ = cheerio.load(html);
  const products = [];

  $('li.h-product[data-product-id]').each((_, el) => {
    const $el = $(el);
    const sku = $el.attr('data-product-id');
    const relUrl = $el.attr('data-url');
    if (!sku || !relUrl) return;
    const url = new URL(relUrl, 'https://www.fnp.ae').toString();
    const name = $el.find('.p-name').first().text().replace(/\s+/g, ' ').trim();
    const priceAttr = $el.find('meta[itemprop="price"]').first().attr('content');
    const currency = $el.find('meta[itemprop="priceCurrency"]').first().attr('content') || 'AED';
    const image = $el.attr('data-img-url') || $el.find('img.u-photo').first().attr('src') || null;
    const priceAED = priceAttr != null ? Number(priceAttr) : null;
    if (!name || priceAED == null) return;
    products.push({ sku, name, url, image, priceAED, currency });
  });

  $('div.product[data-id]').each((_, el) => {
    const $el = $(el);
    const sku = $el.attr('data-id');
    const relUrl = $el.find('a').first().attr('href');
    if (!sku || !relUrl) return;
    const url = new URL(relUrl, 'https://www.fnp.ae').toString();
    const name = $el.find('.p-name').first().text().replace(/\s+/g, ' ').trim();
    const priceText = $el.find('.h-price.webprice').first().text().replace(/[^\d.]/g, '');
    const image = $el.find('img').first().attr('data-imageurl') || $el.find('img').first().attr('src') || null;
    const priceAED = priceText ? Number(priceText) : null;
    if (!name || !Number.isFinite(priceAED)) return;
    products.push({ sku, name, url, image, priceAED, currency: 'AED' });
  });

  return products;
}

// Crawl the fixed category list and return a deduped catalog (by URL).
export async function fetchFnpCatalog() {
  const seen = new Map();
  await Promise.all(
    CATEGORIES.map(async (slug) => {
      try {
        const html = await fetchHtml(`https://www.fnp.ae/${slug}`);
        for (const p of parseCategoryProducts(html)) {
          if (!seen.has(p.url)) seen.set(p.url, p);
        }
      } catch {
        // A single category failing shouldn't blank the whole catalog.
      }
    }),
  );
  return [...seen.values()];
}

// Searches fnp.ae directly for a specific product name — the fallback used
// when a Kapruka product doesn't turn up in the fixed category crawl above
// (e.g. gift boxes/combos that don't map cleanly onto one of the CATEGORIES
// slugs, or items that simply weren't on a category's first page that day).
// Returns the same shape as fetchFnpCatalog since it reuses the same card
// parser — fnp.ae's search results page uses identical markup.
export async function searchFnpProducts(query) {
  const url = `https://www.fnp.ae/search?FNP_CURRENT_CATALOG_ID=uae&qs=${encodeURIComponent(query)}`;
  const html = await fetchHtml(url);
  return parseCategoryProducts(html);
}

// Scrapes a single fnp.ae product page — used for manually-pasted pairing
// URLs that fall outside the crawled categories (e.g. cakes/chocolates,
// whose category page only exposes a rotating subsample, not a stable full
// catalog). fnp.ae product pages carry no JSON-LD/OG price meta; the
// reliable signal is the same <meta itemprop="price" content="..."> tag the
// category-listing crawl already reads (see parseCategoryProducts above) —
// the page used to instead expose a #defaultProductPrice hidden input, but
// that id is gone from current markup (site redesign), which was silently
// turning every direct per-product fetch into a "scrape_failed" row.
export async function fetchFnpProduct(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const priceAttr = $('meta[itemprop="price"]').first().attr('content');
  const priceAED = priceAttr != null ? Number(priceAttr) : null;
  const name = $('h1').first().text().replace(/\s+/g, ' ').trim() || null;
  const image = $('meta[property="og:image"]').first().attr('content') || null;

  return {
    name,
    image,
    priceAED: Number.isFinite(priceAED) ? priceAED : null,
    currency: 'AED',
  };
}
