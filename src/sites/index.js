// Registry of per-site scrapers. Domains listed here use a purpose-built scraper
// that handles variant selection + currency. Everything else falls back to the
// generic extractor.

import { scrapeAbans } from './abans.js';
import { scrapeGeniusMobile } from './geniusmobile.js';
import { scrapeShopify } from './shopify.js';
import { scrapeWoo } from './woocommerce.js';

// Domain-specific scrapers (sites that need bespoke handling, e.g. JS variant
// selectors or cash-vs-card logic) take priority over platform detection.
const REGISTRY = [
  { match: 'buyabans.com', scrape: scrapeAbans },
  { match: 'geniusmobile.lk', scrape: scrapeGeniusMobile },
];

/** Return a per-domain scraper for `domain`, or null if none is registered. */
export function getSiteScraper(domain) {
  const entry = REGISTRY.find((e) => domain.endsWith(e.match));
  return entry ? entry.scrape : null;
}

/**
 * Platform auto-detection: try Shopify (.js), then WooCommerce, for any URL with
 * no domain-specific scraper. Returns the standard result shape, or null if the
 * site is neither (e.g. Magento/custom — caller falls back to the generic path).
 */
export async function scrapeByPlatform(url, opts = {}) {
  const shopify = await scrapeShopify(url, opts);
  if (shopify) return shopify;
  const woo = await scrapeWoo(url, opts);
  if (woo) return woo;
  return null;
}
