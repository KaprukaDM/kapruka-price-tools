// Generic page extractor. Given a product-page URL, return title + ALL candidate
// prices + currency + image, captured without assuming a site-specific layout.
//
// Strategy (cheap -> expensive):
//   1. JSON-LD Product/Offer            (most reliable; canonical price + currency)
//   2. Embedded JSON blob (__NEXT_DATA__, __INITIAL_STATE__ / apollo)  (JS sites)
//   3. Open Graph / product meta tags
//   4. Heuristic price regex over visible text
//   -> if no price found via the cheap (no-browser) path, fall back to Playwright
//
// Never assumes LKR: currency is read from the page. Captures multiple prices so
// the matcher (Claude) can pick the one for the queried variant. Fails loudly:
// returns flags instead of a fabricated number.

import * as cheerio from 'cheerio';

const SCRAPE_PROXY = process.env.SCRAPE_PROXY || '';
const PAGE_TIMEOUT_MS = 20000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Region-biased headers so geo-sensitive pages lean toward LKR rendering.
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'si-LK,en-LK;q=0.9,en;q=0.8',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

const CURRENCY_SYMBOLS = {
  'rs.': 'LKR',
  rs: 'LKR',
  'lkr': 'LKR',
  '₨': 'LKR',
  '$': 'USD',
  'usd': 'USD',
  '€': 'EUR',
  '£': 'GBP',
};

// ---------------------------------------------------------------------------
// Helpers

function toNumber(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;
  // Drop thousands separators, keep last dot as decimal.
  const normalized = cleaned.replace(/,(?=\d{3}\b)/g, '');
  const n = parseFloat(normalized.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pushPrice(prices, { amount, currency, label, kind }) {
  const value = typeof amount === 'number' ? amount : toNumber(amount);
  if (value == null || value <= 0) return;
  prices.push({
    value,
    currency: currency || null,
    label: label || null, // e.g. variant name
    kind: kind || null, // 'regular' | 'sale' | null
  });
}

function detectCurrencyFromText(text) {
  const lower = text.toLowerCase();
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) {
    if (lower.includes(sym)) return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extractors (operate on an HTML string)

function extractFromJsonLd($, prices) {
  let title = null;
  let image = null;
  let currency = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    let json;
    try {
      json = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = Array.isArray(json) ? json : [json];
    for (const node of nodes) {
      const graph = node['@graph'] ? node['@graph'] : [node];
      for (const item of graph) {
        const type = item && item['@type'];
        const isProduct =
          type === 'Product' ||
          (Array.isArray(type) && type.includes('Product'));
        if (!isProduct) continue;
        if (!title && item.name) title = String(item.name);
        if (!image && item.image) {
          image = Array.isArray(item.image) ? item.image[0] : item.image;
        }
        const offers = item.offers
          ? Array.isArray(item.offers)
            ? item.offers
            : [item.offers]
          : [];
        for (const offer of offers) {
          if (!currency && offer.priceCurrency) currency = offer.priceCurrency;
          pushPrice(prices, {
            amount: offer.price ?? offer.lowPrice,
            currency: offer.priceCurrency,
            label: item.name,
            kind: 'sale',
          });
          if (offer.highPrice) {
            pushPrice(prices, {
              amount: offer.highPrice,
              currency: offer.priceCurrency,
              label: item.name,
              kind: 'regular',
            });
          }
        }
      }
    }
  });

  return { title, image, currency };
}

function extractFromMeta($, prices) {
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('title').first().text() ||
    null;
  const image =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    null;
  const amount =
    $('meta[property="product:price:amount"]').attr('content') ||
    $('meta[property="og:price:amount"]').attr('content') ||
    null;
  const currency =
    $('meta[property="product:price:currency"]').attr('content') ||
    $('meta[property="og:price:currency"]').attr('content') ||
    null;
  if (amount) {
    pushPrice(prices, { amount, currency, label: title, kind: 'sale' });
  }
  return { title: title ? title.trim() : null, image, currency: currency || null };
}

// Look for price-ish keys inside embedded JSON state blobs (Next.js / Apollo / etc.)
function extractFromJsonBlobs(html, prices) {
  let currency = null;
  const blobRegexes = [
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i,
    /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i,
  ];
  for (const re of blobRegexes) {
    const m = html.match(re);
    if (!m) continue;
    let json;
    try {
      json = JSON.parse(m[1]);
    } catch {
      continue;
    }
    walkForPrices(json, prices, (cur) => {
      if (!currency && cur) currency = cur;
    });
  }
  return { currency };
}

// Recursively collect numbers under keys that look like prices.
function walkForPrices(obj, prices, onCurrency, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  for (const [key, val] of Object.entries(obj)) {
    const k = key.toLowerCase();
    if (k === 'pricecurrency' || k === 'currency' || k === 'currencycode') {
      if (typeof val === 'string') onCurrency(val);
    }
    if (
      (k.includes('price') || k === 'amount') &&
      (typeof val === 'number' || typeof val === 'string')
    ) {
      const kind = k.includes('sale') || k.includes('special') || k.includes('final')
        ? 'sale'
        : k.includes('original') || k.includes('regular') || k.includes('list')
          ? 'regular'
          : null;
      pushPrice(prices, { amount: val, kind });
    }
    if (val && typeof val === 'object') {
      walkForPrices(val, prices, onCurrency, depth + 1);
    }
  }
}

function extractFromVisibleText($, prices) {
  // Last resort: scan elements whose class/id hints at price.
  const text = $('body').text();
  const currency = detectCurrencyFromText(text);
  const priceRe = /(?:rs\.?|lkr|₨|\$)\s*([\d.,]{3,})/gi;
  let m;
  let count = 0;
  while ((m = priceRe.exec(text)) && count < 6) {
    pushPrice(prices, { amount: m[1], currency, kind: null });
    count++;
  }
  return { currency };
}

// ---------------------------------------------------------------------------
// Page fetching

async function fetchHtml(url) {
  const opts = { headers: BASE_HEADERS, redirect: 'follow' };
  if (SCRAPE_PROXY) {
    // node fetch honors no proxy by default; use undici ProxyAgent if configured.
    const { ProxyAgent } = await import('undici');
    opts.dispatcher = new ProxyAgent(SCRAPE_PROXY);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// Playwright fallback for pages that render price client-side.
async function fetchRenderedHtml(url) {
  const { chromium } = await import('playwright');
  const launchOpts = {};
  if (SCRAPE_PROXY) launchOpts.proxy = { server: SCRAPE_PROXY };
  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: 'en-LK',
      extraHTTPHeaders: { 'Accept-Language': BASE_HEADERS['Accept-Language'] },
    });
    const page = await context.newPage();
    // domcontentloaded (not networkidle): these sites keep trackers polling, so
    // networkidle never settles and burns the full timeout on every page.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(2500);
    return await page.content();
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Scrape one product URL.
 * Returns { title, prices, currency, image, url, extractionMethod, flags }.
 * `prices` is an array of { value, currency, label, kind }. Never throws on a
 * bad page — returns flags instead.
 */
export async function scrapeProduct(url) {
  const result = {
    title: null,
    prices: [],
    currency: null,
    image: null,
    url,
    extractionMethod: null,
    flags: [],
  };

  // ---- cheap path: static HTML ----
  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    result.flags.push('fetch_failed');
    result.error = err.message;
    return result;
  }

  applyExtractors(html, result, 'static');

  // ---- fallback: render with a browser if no price yet ----
  if (result.prices.length === 0) {
    try {
      const rendered = await fetchRenderedHtml(url);
      applyExtractors(rendered, result, 'rendered');
    } catch (err) {
      result.flags.push('render_failed');
      result.renderError = err.message;
    }
  }

  finalize(result);
  return result;
}

function applyExtractors(html, result, sourceLabel) {
  const $ = cheerio.load(html);
  const ld = extractFromJsonLd($, result.prices);
  const blob = extractFromJsonBlobs(html, result.prices);
  const meta = extractFromMeta($, result.prices);
  if (result.prices.length === 0) {
    extractFromVisibleText($, result.prices);
  }

  result.title = result.title || ld.title || meta.title;
  result.image = result.image || ld.image || meta.image;
  result.currency =
    result.currency || ld.currency || meta.currency || blob.currency || null;

  if (!result.extractionMethod && result.prices.length > 0) {
    result.extractionMethod = ld.title || ld.currency ? `jsonld(${sourceLabel})` : sourceLabel;
  }
}

function finalize(result) {
  // De-duplicate identical prices.
  const seen = new Set();
  result.prices = result.prices.filter((p) => {
    const key = `${p.value}|${p.kind}|${p.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (result.prices.length === 0) {
    result.flags.push('price_not_found');
    return;
  }

  // Infer currency if any price carried one but top-level is unset.
  if (!result.currency) {
    const withCur = result.prices.find((p) => p.currency);
    if (withCur) result.currency = withCur.currency;
  }
  if (!result.currency) {
    result.flags.push('currency_unknown');
  } else if (result.currency.toUpperCase() !== 'LKR') {
    // Found a price but it's not in rupees — likely geo-IP currency flip.
    result.flags.push('currency_mismatch');
  }
}
