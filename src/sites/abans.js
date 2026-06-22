// Per-site scraper for Abans (buyabans.com).
//
// This page is a JS variant-selector with a LKR/USD switcher, so generic
// extraction can't get a specific variant's price. Here we drive it like a user:
//   - force LKR via ?currency=LKR
//   - read the real storage variants from `.size-box` swatches
//   - click each storage variant and read the live price from `.product-main-price-con`
//
// Returns deterministic, variant-accurate data. Honest by construction: if the
// requested storage isn't offered, we say so and list what IS available.

import { chromium } from 'playwright';
import { normalizeStorage } from '../variant.js';

const SCRAPE_PROXY = process.env.SCRAPE_PROXY || '';
const NAV_TIMEOUT = 45000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function withLkr(url) {
  const u = new URL(url);
  u.searchParams.set('currency', 'LKR');
  return u.toString();
}

function parsePrice(text) {
  if (!text) return null;
  // LKR retail prices are integers; strip everything but digits so "Rs. 299,999"
  // -> 299999 (avoids the "Rs." dot being read as a decimal point).
  const digits = String(text).replace(/[^0-9]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {string} url       product page URL on buyabans.com
 * @param {{storage?: string}} opts  requested storage, e.g. "512GB"
 * @returns {Promise<object>} structured, variant-accurate result
 */
export async function scrapeAbans(url, opts = {}) {
  const requested = normalizeStorage(opts.storage);
  const result = {
    site: 'Abans',
    domain: 'buyabans.com',
    url,
    title: null,
    currency: 'LKR',
    requestedStorage: requested,
    availableStorages: [],
    variantPrices: {}, // { "128GB": 299999, ... }
    price: null, // price for the requested storage (or default if none requested)
    flags: [],
  };

  const launchOpts = {};
  if (SCRAPE_PROXY) launchOpts.proxy = { server: SCRAPE_PROXY };
  const browser = await chromium.launch(launchOpts);
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'en-LK' });
    const page = await ctx.newPage();
    await page.goto(withLkr(url), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Wait for either a price or a variant swatch to render.
    await page
      .locator('.product-main-price-con, .main-price, .size-box')
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    result.title =
      (await page.locator('h1').first().textContent().catch(() => null))?.trim() ||
      (await page.title().catch(() => null));
    result.image =
      (await page.locator('meta[property="og:image"]').first().getAttribute('content').catch(() => null)) ||
      null;

    const readPrice = async () => {
      // Read the SELLING price element only. The wrapper (.product-main-price-con)
      // also contains the struck-through .market-price, which would glue two
      // numbers together. Order = most specific current-price element first.
      const selectors = [
        '.main-price .selling-price-de',
        '.selling-price-de',
        '.main-price',
      ];
      for (const sel of selectors) {
        const t = await page.locator(sel).first().textContent().catch(() => null);
        if (t && t.trim()) {
          if (/\$|USD/i.test(t)) result.flags.push('currency_mismatch');
          const v = parsePrice(t);
          if (v != null) return v;
        }
      }
      return null;
    };

    // Discover storage swatches (size-box also holds colours; keep only GB/TB).
    const swatchTexts = (await page.locator('.size-box').allTextContents())
      .map((t) => t.replace(/\s+/g, ' ').trim());
    const storages = [];
    for (const t of swatchTexts) {
      const norm = normalizeStorage(t);
      if (norm && !storages.includes(norm)) storages.push(norm);
    }
    result.availableStorages = storages;

    if (storages.length === 0) {
      // No variant selector found — just read whatever price is shown.
      result.price = await readPrice();
      if (result.price == null) result.flags.push('price_not_found');
      return result;
    }

    // Click each storage, read its price -> full variant map.
    for (const storage of storages) {
      const swatch = page.locator('.size-box', { hasText: storage }).first();
      await swatch.click().catch(() => {});
      await page.waitForTimeout(1800);
      const price = await readPrice();
      if (price != null) result.variantPrices[storage] = price;
    }

    if (requested) {
      if (result.variantPrices[requested] != null) {
        result.price = result.variantPrices[requested];
      } else {
        // Requested variant not sold here — be explicit, don't fake it.
        result.flags.push('variant_unavailable');
        result.price = null;
      }
    } else {
      // No specific variant asked for: report the cheapest real variant.
      const vals = Object.values(result.variantPrices);
      result.price = vals.length ? Math.min(...vals) : null;
      if (result.price == null) result.flags.push('price_not_found');
    }

    return result;
  } catch (err) {
    result.flags.push('scrape_failed');
    result.error = err.message;
    return result;
  } finally {
    await browser.close();
  }
}
