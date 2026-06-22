// Per-site scraper for Genius Mobile (geniusmobile.lk).
//
// WooCommerce, server-rendered (no browser needed). Each storage variant is its
// own URL, so the variant comes from the page title. A product page shows three
// kinds of price:
//   - cash price        (the real headline price) -> lowest .gateway-price
//   - card/gateway price (cash + payment-gateway surcharge) -> higher .gateway-price
//   - Koko "3 X ..." installment thirds -> ignore
// Currency symbol is "රු" (Sinhala), which we map to LKR.

import * as cheerio from 'cheerio';
import { parseStorage, normalizeStorage } from '../variant.js';

const SCRAPE_PROXY = process.env.SCRAPE_PROXY || '';
const PAGE_TIMEOUT_MS = 20000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'si-LK,en-LK;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function parseLkr(text) {
  if (!text) return null;
  // Handles "රු242,990.00" and "Rs. 242,990". Take the first amount, drop
  // thousands separators, round to whole rupees.
  const m = String(text).match(/([\d.,]{3,})/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

async function fetchHtml(url) {
  const opts = { headers: HEADERS, redirect: 'follow' };
  if (SCRAPE_PROXY) {
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

/**
 * @param {string} url   product page URL on geniusmobile.lk
 * @param {{storage?: string}} opts  requested storage, e.g. "256GB"
 */
export async function scrapeGeniusMobile(url, opts = {}) {
  const requested = normalizeStorage(opts.storage);
  const result = {
    site: 'Genius Mobile',
    domain: 'geniusmobile.lk',
    url,
    title: null,
    currency: 'LKR',
    requestedStorage: requested,
    availableStorages: [],
    variantPrices: {},
    price: null,
    cardPrices: [],
    priceContext: '',
    flags: [],
  };

  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    result.flags.push('fetch_failed');
    result.error = err.message;
    return result;
  }

  const $ = cheerio.load(html);

  // Title (storage lives here, since each variant is its own URL).
  result.title =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    null;
  result.image = $('meta[property="og:image"]').attr('content') || null;

  // Payment-method prices. Scope to the product summary so we don't pick up
  // related-product prices elsewhere on the page.
  const scope = $('.summary.entry-summary, .entry-summary, .summary').first();
  const root = scope.length ? scope : $.root();
  const gatewayAmounts = [];
  root.find('.gateway-price').each((_, el) => {
    const v = parseLkr($(el).text());
    if (v != null) gatewayAmounts.push(v);
  });

  // Currency guard: if the page shows USD/$, flag it.
  if (/\$|USD/i.test(root.text())) result.flags.push('currency_mismatch');

  // Cash price = the lowest payment-method price (card options add a surcharge).
  let cash = null;
  if (gatewayAmounts.length) {
    cash = Math.min(...gatewayAmounts);
    result.cardPrices = [...new Set(gatewayAmounts)].filter((v) => v !== cash).sort((a, b) => a - b);
  } else {
    // Fallback: first WooCommerce amount in the summary.
    const amt = root.find('.woocommerce-Price-amount').first().text();
    cash = parseLkr(amt);
  }

  if (cash == null) {
    result.flags.push('price_not_found');
    return result;
  }

  // Storage from title; each Genius URL is a single variant.
  const detected = parseStorage(result.title) || requested || 'variant';
  result.availableStorages = [detected];
  result.variantPrices = { [detected]: cash };

  if (requested && detected !== 'variant' && requested !== detected) {
    // This page is a different storage than asked — don't present it as a match.
    result.flags.push('variant_unavailable');
    result.price = null;
    result.priceContext = `This page is ${detected}, not ${requested}.`;
  } else {
    result.price = cash;
    const cardNote = result.cardPrices.length
      ? ` (card from රු${result.cardPrices[0].toLocaleString('en-LK')})`
      : '';
    result.priceContext = `${detected === 'variant' ? '' : detected + ' · '}cash price${cardNote}`;
  }

  return result;
}
