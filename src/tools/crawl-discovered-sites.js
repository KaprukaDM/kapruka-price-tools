// Crawls the full catalogue of each APPROVED-worthy discovered site into
// competitor_products, then marks it approved so it drops off the review
// queue (discovered-sites.html).
//
// Why this exists: a discovered site previously only ever contributed the
// single page a web search happened to surface (pipeline.js's
// processDiscovered scrapes exactly that URL). That makes the Price Checker
// only as good as the search engine's pick -- searching "Keto Peanut Spread
// 340g" surfaced *Herman* Peanut Butter pages on five different sites, so the
// checker compared against the wrong product while the right one
// ("Keto Nas Creamy Peanut Spread 340G") sat un-looked-at in the same shop.
// Caching each site's whole catalogue here lets checker/db-search.js match
// against every product a shop actually sells instead.
//
// Usage:
//   node src/tools/crawl-discovered-sites.js            # crawl + approve all pending
//   node src/tools/crawl-discovered-sites.js --dry      # report only, change nothing
//   node src/tools/crawl-discovered-sites.js --only=onlinekade.lk,chu.lk
//   node src/tools/crawl-discovered-sites.js --keep-pending   # crawl but don't approve

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { decodeEntities } from '../compare/normalize.js';
import {
  listDiscoveredSites,
  setDiscoveredSiteStatus,
  upsertCompetitorProducts,
  storageKind,
} from '../db.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which Price Checker category each site's products get filed under. These
// sites were all discovered through the general "Other" search path, so none
// carries a category of its own -- inferred here from what the shop actually
// sells (and the query that surfaced it). Anything not listed falls back to
// Grocery, which is what the bulk of these are.
const CATEGORY_BY_DOMAIN = {
  'cyberdeals.lk': 'Mobile Phones',      // surfaced by "Iphone 12 cover"
  'chu.lk': 'Cosmetics',                 // personal care / toiletries
  'kinderlandkidshop.com': 'Cosmetics',  // kids toiletries, same shelf as above
  'thechocolatehouse.lk': 'Chocolates',
};
const DEFAULT_CATEGORY = 'Grocery';

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function parsePriceLKR(text) {
  if (text == null) return null;
  const m = String(text).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// WooCommerce Store API prices are integer strings scaled by minor unit.
function wooPrice(p) {
  const raw = p?.prices?.price;
  if (raw == null) return null;
  const minor = p.prices.currency_minor_unit ?? 2;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  const v = minor ? n / 10 ** minor : n;
  return v > 0 ? Math.round(v) : null;
}

async function wooCatalog(domain) {
  const out = [];
  let useRestRoute = false;
  for (let page = 1; page <= 300; page++) {
    const pretty = `https://${domain}/wp-json/wc/store/v1/products?page=${page}&per_page=100&orderby=id&order=asc`;
    const rest = `https://${domain}/?rest_route=/wc/store/v1/products&page=${page}&per_page=100&orderby=id&order=asc`;
    let data = await fetchJson(useRestRoute ? rest : pretty);
    if (!Array.isArray(data) && page === 1 && !useRestRoute) {
      data = await fetchJson(rest);
      if (Array.isArray(data)) useRestRoute = true;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    for (const p of data) out.push({ name: decodeEntities(p.name), url: p.permalink, priceLKR: wooPrice(p) });
    if (data.length < 100) break;
    await sleep(250);
  }
  return out;
}

async function shopifyCatalog(domain) {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const data = await fetchJson(`https://${domain}/products.json?limit=250&page=${page}`);
    const products = data?.products || [];
    if (products.length === 0) break;
    for (const p of products) {
      const v = (p.variants || [])[0];
      out.push({
        name: decodeEntities(p.title),
        url: `https://${domain}/products/${p.handle}`,
        priceLKR: v ? parsePriceLKR(v.price) : null,
      });
    }
    if (products.length < 250) break;
    await sleep(250);
  }
  return out;
}

// OpenCart: no catalogue endpoint, but its search route spans every category.
// Union a few single-letter queries so a product missing one letter is still
// caught (same approach as the limitededition.lk partner adapter).
const OC_TERMS = ['a', 'e', 'i', 'o', 'u', 's'];
async function opencartCatalog(domain) {
  const byUrl = new Map();
  for (const term of OC_TERMS) {
    for (let page = 1; page <= 30; page++) {
      const html = await fetchText(
        `https://${domain}/index.php?route=product/search&search=${term}&limit=100&page=${page}`,
      );
      if (!html) break;
      const $ = cheerio.load(html);
      let found = 0;
      $('div.product-thumb, div.product-layout').each((_, el) => {
        const $c = $(el);
        const $a = $c.find('h4 a, .name a, .caption a').first();
        let href = $a.attr('href');
        if (!href) return;
        if (!href.startsWith('http')) href = new URL(href, `https://${domain}`).toString();
        href = href.split('?')[0];
        found++;
        if (byUrl.has(href)) return;
        const $price = $c.find('.price').first();
        const $new = $price.find('.price-new').first();
        const priceLKR = parsePriceLKR(
          $new.length ? $new.text() : $price.clone().children().remove().end().text(),
        );
        const name = decodeEntities($a.text()).replace(/\s+/g, ' ').trim();
        if (!name) return;
        byUrl.set(href, { name, url: href, priceLKR });
      });
      if (found === 0) break;
      const shown = html.match(/Showing\s+\d+\s+to\s+(\d+)\s+of\s+(\d+)/i);
      if (shown && Number(shown[1]) >= Number(shown[2])) break;
      await sleep(350);
    }
  }
  return [...byUrl.values()];
}

// Try each known platform in turn. Ordered cheapest-first: the two JSON APIs
// are a single request to disprove, the OpenCart path costs many.
async function crawlSite(domain) {
  const woo = await wooCatalog(domain);
  if (woo.length) return { products: woo, platform: 'woocommerce' };

  const shop = await shopifyCatalog(domain);
  if (shop.length) return { products: shop, platform: 'shopify' };

  const home = await fetchText(`https://${domain}/`);
  if (home && /opencart|route=product/i.test(home)) {
    const oc = await opencartCatalog(domain);
    if (oc.length) return { products: oc, platform: 'opencart' };
  }
  return { products: [], platform: null };
}

async function main() {
  const dry = process.argv.includes('--dry');
  const keepPending = process.argv.includes('--keep-pending');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null;

  console.log(`Storage backend: ${storageKind}${dry ? '  [DRY RUN]' : ''}`);
  let pending = await listDiscoveredSites('pending');
  if (only) pending = pending.filter((d) => only.has(d.domain));
  console.log(`Crawling ${pending.length} discovered site(s)…\n`);

  let approved = 0;
  let skipped = 0;
  let totalProducts = 0;

  for (const site of pending) {
    const category = CATEGORY_BY_DOMAIN[site.domain] || DEFAULT_CATEGORY;
    process.stdout.write(`${site.domain} [${category}] … `);
    let result;
    try {
      result = await crawlSite(site.domain);
    } catch (err) {
      console.log(`FAILED: ${err.message.slice(0, 70)}`);
      skipped++;
      continue;
    }
    const { products, platform } = result;
    const priced = products.filter((p) => p.priceLKR != null);
    if (products.length === 0) {
      // Left pending on purpose: no catalogue means nothing to approve, and
      // it stays on the review queue for a human to look at by hand.
      console.log('no catalogue found — left pending');
      skipped++;
      continue;
    }
    console.log(`${products.length} products (${priced.length} priced) via ${platform}`);
    totalProducts += products.length;

    if (dry) continue;
    try {
      await upsertCompetitorProducts(
        site.domain,
        products.map((p) => ({ ...p, siteName: site.domain })),
        category,
      );
      if (!keepPending) {
        await setDiscoveredSiteStatus(site.id, 'approved');
        approved++;
      }
    } catch (err) {
      console.log(`  ! save failed: ${err.message.slice(0, 90)}`);
      skipped++;
    }
  }

  console.log(
    `\nDone — ${totalProducts} products cached, ${approved} site(s) approved, ${skipped} skipped/left pending.`,
  );
}

main().catch((err) => {
  console.error('Crawl failed:', err);
  process.exitCode = 1;
});
