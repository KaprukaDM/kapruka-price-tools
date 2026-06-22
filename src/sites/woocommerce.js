// Platform adapter: WooCommerce.
//
// Covers any WooCommerce store. Price sources, in order of reliability:
//   1. JSON-LD Product/Offer price (simple products) — most reliable
//   2. Inline variable-product data (form.variations_form[data-product_variations])
//   3. Visible .woocommerce-Price-amount in the product summary (best effort)
// Currency "රු"/"Rs"/"LKR" -> LKR.

import * as cheerio from 'cheerio';

const PAGE_TIMEOUT_MS = 20000;
const H = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'si-LK,en-LK', Accept: 'text/html,*/*' };

async function fetchHtml(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), PAGE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: H, redirect: 'follow', signal: c.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function parseAmount(text) {
  if (!text) return null;
  const m = String(text).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[1]));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function jsonLdPrice($) {
  let price = null;
  let currency = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).contents().text());
      const arr = Array.isArray(j) ? j : j['@graph'] || [j];
      for (const n of arr) {
        const ty = n && n['@type'];
        if (ty === 'Product' || (Array.isArray(ty) && ty.includes('Product'))) {
          const offers = n.offers ? (Array.isArray(n.offers) ? n.offers : [n.offers]) : [];
          for (const o of offers) {
            const p = parseAmount(o.price ?? o.lowPrice);
            if (p != null && price == null) price = p;
            if (o.priceCurrency && !currency) currency = o.priceCurrency;
          }
        }
      }
    } catch {
      /* ignore */
    }
  });
  return { price, currency };
}

/**
 * Try to scrape `url` as a WooCommerce product. Returns the standard result
 * shape, or null if it isn't a WooCommerce page.
 */
export async function scrapeWoo(url, _opts = {}) {
  const html = await fetchHtml(url);
  if (!html) return null;
  if (!/woocommerce|wp-content\/plugins\/woocommerce/i.test(html)) return null; // not Woo

  const $ = cheerio.load(html);
  const result = {
    platform: 'woocommerce',
    url,
    title: $('h1').first().text().trim() || $('meta[property="og:title"]').attr('content') || null,
    image: $('meta[property="og:image"]').attr('content') || null,
    currency: 'LKR',
    availableStorages: [],
    variantPrices: {},
    price: null,
    priceContext: '',
    flags: [],
  };

  // 1) JSON-LD (simple products)
  const ld = jsonLdPrice($);
  if (ld.currency && !/lkr/i.test(ld.currency)) result.currency = ld.currency;
  if (ld.price != null) {
    result.price = ld.price;
    result.priceContext = 'list price';
    return result;
  }

  const scope = $('.summary.entry-summary, .entry-summary, .summary, .product').first();
  const root = scope.length ? scope : $.root();

  // 2) Inline variable-product data
  const vform = root.find('form.variations_form, .variations_form').first();
  const raw = vform.attr('data-product_variations');
  if (raw && raw !== 'true' && raw !== 'false') {
    try {
      const vars = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const prices = [];
      for (const v of vars) {
        const p = parseAmount(v.display_price ?? v.display_regular_price);
        const label = Object.values(v.attributes || {}).join(' / ') || 'variant';
        if (p != null) {
          result.variantPrices[label] = p;
          prices.push(p);
        }
      }
      if (prices.length) {
        result.price = Math.min(...prices);
        result.availableStorages = Object.keys(result.variantPrices);
        result.priceContext =
          prices.length > 1 ? `from (cheapest of ${prices.length} variants)` : 'list price';
        return result;
      }
    } catch {
      /* fall through */
    }
  }

  // 3) Visible amount(s) in the summary (best effort — variable products may
  //    show a range; we take the lowest shown and flag it as approximate).
  const amounts = [];
  root.find('.woocommerce-Price-amount').slice(0, 6).each((_, el) => {
    const v = parseAmount($(el).text());
    if (v != null) amounts.push(v);
  });
  if (/\$|USD/i.test(root.text())) result.flags.push('currency_mismatch');
  if (amounts.length) {
    result.price = Math.min(...amounts);
    if (amounts.length > 1) {
      result.flags.push('price_approx');
      result.priceContext = `from රු${result.price.toLocaleString('en-LK')} (price varies by option)`;
    } else {
      result.priceContext = 'list price';
    }
    return result;
  }

  result.flags.push('price_not_found');
  return result;
}
