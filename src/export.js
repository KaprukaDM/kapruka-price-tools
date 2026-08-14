// CSV exporters for the saved scrape data. Each stored run holds a full JSON
// payload (see db.js); here we flatten those payloads into one spreadsheet row
// per scraped product so the data opens cleanly in Excel / Google Sheets.
//
// A UTF-8 BOM is prepended so Excel renders Sri Lankan/Unicode product names
// correctly instead of mojibake.

import { allPriceCheckRows, allComparisonRows, getPriceAuditItems, removedUrlSet, recentComparisonRuns, getComparisonRun } from './db.js';
import { listPartners } from './compare/partners.js';

// The Overpriced / All Products Overpriced / Stock Mismatch dashboards (and
// their CSV exports) all re-scan the same handful of full tables on every
// single page load -- data that only changes when a scheduled refresh/audit
// run writes to it (compare/run.js, *-audit/match-local.js), not on every
// view. Cache each read for a few hours so back-to-back dashboard loads
// reuse one fetch instead of re-scanning the whole table each time -- same
// fix already applied to the Price Checker's DB search (checker/db-search.js).
// Every call site below uses identical (or no) arguments, so a single
// args-blind cache per function is safe.
const REPORT_CACHE_TTL_MS = 5 * 60 * 60 * 1000;
function cached(fn) {
  let entry = null;
  return (...args) => {
    const now = Date.now();
    if (!entry || now - entry.at >= REPORT_CACHE_TTL_MS) {
      const promise = fn(...args);
      entry = { at: now, promise };
      promise.catch(() => { entry = null; });
    }
    return entry.promise;
  };
}
const cachedAllComparisonRows = cached(allComparisonRows);
const cachedGetPriceAuditItems = cached(getPriceAuditItems);
const cachedRemovedUrlSet = cached(removedUrlSet);
const cachedAllPriceCheckRows = cached(allPriceCheckRows);

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// columns: [{ key, label }]; rows: array of plain objects keyed by `key`.
function buildCsv(columns, rows) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(',')).join('\r\n');
  return `﻿${head}\r\n${body}${rows.length ? '\r\n' : ''}`;
}

// ---- Price Checker: one row per matched store result ----

const PRICE_CHECK_COLUMNS = [
  { key: 'check_id', label: 'Check ID' },
  { key: 'checked_at', label: 'Checked at' },
  { key: 'category', label: 'Category' },
  { key: 'query_name', label: 'Searched product' },
  { key: 'query_description', label: 'Description' },
  { key: 'group', label: 'Source group' },
  { key: 'site', label: 'Site' },
  { key: 'domain', label: 'Domain' },
  { key: 'matched_title', label: 'Matched product' },
  { key: 'price', label: 'Price' },
  { key: 'currency', label: 'Currency' },
  { key: 'match_rate', label: 'Match rate %' },
  { key: 'status', label: 'Status' },
  { key: 'flags', label: 'Flags' },
  { key: 'price_context', label: 'Price note' },
  { key: 'url', label: 'URL' },
];

export async function exportPriceChecksCsv() {
  const rows = [];
  for (const row of await cachedAllPriceCheckRows()) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    const meta = {
      check_id: row.id,
      checked_at: row.created_at,
      category: payload.category ?? '',
      query_name: payload.query?.name ?? '',
      query_description: payload.query?.description ?? '',
    };
    const groups = [
      ['curated', payload.results || []],
      ['discovered', payload.discovered || []],
    ];
    for (const [group, list] of groups) {
      for (const r of list) {
        rows.push({
          ...meta,
          group,
          site: r.site ?? '',
          domain: r.domain ?? '',
          matched_title: r.title ?? '',
          price: r.price ?? '',
          currency: r.currency ?? '',
          match_rate: r.matchRate ?? '',
          status: r.status ?? '',
          flags: (r.flags || []).join('; '),
          price_context: r.priceContext ?? '',
          url: r.url ?? '',
        });
      }
    }
  }
  return buildCsv(PRICE_CHECK_COLUMNS, rows);
}

// ---- Unified product sheet (both tools, deduped) ------------------------
// One row per unique product across BOTH tools, keyed by link (newest price
// wins; descriptive fields are backfilled from older rows). Shaped for feeding
// a downstream product-approval system: Category, Brand, Product Name, Link,
// Price first, then Currency / Source / Captured-at for context.

const PRODUCT_COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'brand', label: 'Brand' },
  { key: 'product_name', label: 'Product Name' },
  { key: 'link', label: 'Link' },
  { key: 'price', label: 'Price' },
  { key: 'currency', label: 'Currency' },
  { key: 'source', label: 'Source' },
  { key: 'captured_at', label: 'Captured at' },
];

// Returns an array of plain product objects (also used by the JSON API).
export async function productRows() {
  const map = new Map();

  const upsert = (row) => {
    if (!row.product_name) return; // a product-approval feed needs a name
    const key = (row.link || `${row.source}|${row.product_name}`).trim().toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, row);
      return;
    }
    // Newest capture wins for price/source; backfill descriptive gaps from the other.
    const newer = row.captured_at > existing.captured_at ? row : existing;
    const older = newer === row ? existing : row;
    const merged = { ...newer };
    for (const f of ['category', 'brand', 'product_name']) {
      if (!merged[f] && older[f]) merged[f] = older[f];
    }
    map.set(key, merged);
  };

  // 1) Price Checker results (Category comes from the query; no Brand captured).
  for (const r of await cachedAllPriceCheckRows()) {
    let payload;
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      continue;
    }
    const category = payload.category || '';
    for (const list of [payload.results || [], payload.discovered || []]) {
      for (const item of list) {
        if (item.price == null) continue; // a product approval feed needs a price
        upsert({
          category,
          brand: '',
          product_name: item.title || '',
          link: item.url || '',
          price: item.price,
          currency: item.currency || 'LKR',
          source: `Price Checker · ${item.site || item.domain || ''}`.trim(),
          captured_at: r.created_at,
        });
      }
    }
  }

  // 2) Comparison runs — both the Kapruka listing and the partner listing.
  for (const r of await cachedAllComparisonRows()) {
    let payload;
    try {
      payload = JSON.parse(r.payload_json);
    } catch {
      continue;
    }
    const partnerName = payload.partner?.name || 'partner';
    for (const m of payload.matched || []) {
      // A matched pair is the same product, so the Kapruka row borrows the
      // partner's brand/category (Kapruka's own listing doesn't expose them).
      const brand = m.partnerBrand || '';
      const category = m.partnerCategory || '';
      if (m.kaprukaPrice != null) {
        upsert({
          category,
          brand,
          product_name: m.name || '',
          link: m.kaprukaUrl || '',
          price: m.kaprukaPrice,
          currency: 'LKR',
          source: 'Comparison · Kapruka',
          captured_at: r.created_at,
        });
      }
      if (m.partnerPrice != null) {
        upsert({
          category,
          brand,
          product_name: m.partnerName || '',
          link: m.partnerUrl || '',
          price: m.partnerPrice,
          currency: 'LKR',
          source: `Comparison · ${partnerName}`,
          captured_at: r.created_at,
        });
      }
    }
  }

  // Stable, human-friendly ordering: by product name.
  return [...map.values()].sort((a, b) =>
    (a.product_name || '').localeCompare(b.product_name || ''),
  );
}

export async function exportProductsCsv() {
  return buildCsv(PRODUCT_COLUMNS, await productRows());
}

// ---- Overpriced dashboard: every overpriced product across ALL partners -----
// One consolidated view answering "where are we overcharging vs the partner's
// own site?" — pulls the LATEST stored comparison run for each partner, keeps
// only the `kapruka_higher` matches, and merges them into a single list sorted
// by the biggest rupee overcharge first. Used by /api/overpriced and the
// Overpriced dashboard page.

// Kapruka product URLs carry their catalogue category as a code in the
// /kid/<code> segment — either bare ("elec00a5982") or prefixed with
// "ef_pc_" ("ef_pc_groc0v1868p00005"). comparison_runs never stored a
// category column (that's the newer price_audit_items audit tables'
// column), so this is the only way to recover one for the Overpriced
// Dashboard's data. Prefixes observed in stored data map to a friendly
// label; anything else still gets a readable capitalized fallback rather
// than lumping into an opaque "Other".
const CATEGORY_PREFIX_MAP = {
  elec: 'Electronics',
  clot: 'Clothing',
  book: 'Books',
  cosm: 'Cosmetics',
  home: 'Home & Lifestyle',
  kids: 'Kids',
  groc: 'Groceries',
  perf: 'Perfume & Fragrance',
  scho: 'School & Office',
  spor: 'Sports',
  auto: 'Automotive',
  jewe: 'Jewellery',
  adul: 'Adult',
  moth: 'Mother & Baby',
  phar: 'Pharmacy',
  flow: 'Flowers',
};

function categoryFromKaprukaUrl(url) {
  const m = String(url || '').match(/\/kid\/(?:ef_pc_)?([a-z]+)/i);
  if (!m) return 'Other';
  const prefix = m[1].toLowerCase();
  return CATEGORY_PREFIX_MAP[prefix] || prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

// Latest stored comparison run per partner (newest by row id wins).
async function latestRunPerPartner() {
  const latest = new Map(); // partnerId -> { created_at, payload }
  for (const row of await cachedAllComparisonRows()) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    const pid = payload.partner?.id || `row-${row.id}`;
    // Rows arrive ordered by id ascending, so a later row overwrites an earlier
    // one for the same partner — leaving the most recent run.
    latest.set(pid, { created_at: row.created_at, payload });
  }
  return latest;
}

export async function overpricedReport() {
  const items = [];
  const partners = [];
  let lastUpdated = null;
  const removed = await cachedRemovedUrlSet();

  for (const { created_at, payload } of (await latestRunPerPartner()).values()) {
    const p = payload.partner || {};
    const at = payload.generatedAt || created_at;
    if (!lastUpdated || at > lastUpdated) lastUpdated = at;

    // Team-curated exclusions (e.g. the partner's higher price is explained
    // by a bundled add-on) — see removed_products in db.js.
    const over = (payload.matched || []).filter((m) => m.verdict === 'kapruka_higher' && !removed.has(m.kaprukaUrl));
    partners.push({
      id: p.id ?? '',
      name: p.name ?? '',
      partnerLabel: p.partnerLabel || p.partnerSite || '',
      overpriced: over.length,
      matched: (payload.matched || []).length,
      generatedAt: at,
    });

    for (const m of over) {
      items.push({
        partnerId: p.id ?? '',
        partner: p.name ?? '',
        partnerLabel: p.partnerLabel || p.partnerSite || '',
        category: categoryFromKaprukaUrl(m.kaprukaUrl),
        name: m.name ?? '',
        partnerProductName: m.partnerName ?? '',
        kaprukaPrice: m.kaprukaPrice ?? null,
        partnerPrice: m.partnerPrice ?? null,
        partnerRegularPrice: m.partnerRegularPrice ?? null,
        diff: m.diff ?? null,
        pct: m.pct ?? null,
        confidence: m.confidence ?? '',
        nameSimilarity: m.nameSimilarity ?? null,
        kaprukaUrl: m.kaprukaUrl ?? '',
        partnerUrl: m.partnerUrl ?? '',
        generatedAt: at,
      });
    }
  }

  // Biggest rupee overcharge first.
  items.sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0));
  partners.sort((a, b) => b.overpriced - a.overpriced);

  return {
    lastUpdated,
    count: items.length,
    totalOvercharge: items.reduce((sum, i) => sum + (i.diff ?? 0), 0),
    partners,
    items,
  };
}

const OVERPRICED_COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'partner', label: 'Store' },
  { key: 'name', label: 'Product' },
  { key: 'kaprukaPrice', label: 'Kapruka price' },
  { key: 'partnerPrice', label: 'Partner price' },
  { key: 'partnerRegularPrice', label: 'Partner regular price' },
  { key: 'diff', label: 'Overcharge (Rs.)' },
  { key: 'pct_out', label: 'Overcharge %' },
  { key: 'confidence', label: 'Match confidence' },
  { key: 'nameSimilarity', label: 'Name similarity %' },
  { key: 'kaprukaUrl', label: 'Kapruka URL' },
  { key: 'partnerUrl', label: 'Partner URL' },
  { key: 'generatedAt', label: 'Updated at' },
];

export async function exportOverpricedCsv(partnerId = null, category = null) {
  const { items } = await overpricedReport();
  const filtered = items.filter(
    (i) => (!partnerId || i.partnerId === partnerId) && (!category || i.category === category),
  );
  const rows = filtered.map((i) => ({
    ...i,
    pct_out: i.pct != null ? Math.round(i.pct * 10) / 10 : '',
  }));
  return buildCsv(OVERPRICED_COLUMNS, rows);
}

// ---- Stock mismatch dashboard: matched products split by stock status -----
// Reads the same latest-per-partner comparison runs as overpricedReport(),
// but instead of price splits matched pairs into three buckets:
//   partnerOutOfStock - we still have it, the partner's site doesn't (an
//                       opportunity we could be capturing that they can't).
//   kaprukaOutOfStock - the partner has it, we don't (a gap worth restocking).
//   bothOutOfStock    - out of stock everywhere (neither side can sell it).
// Both-in-stock pairs aren't interesting and are left out entirely. Relies on
// kaprukaInStock/partnerInStock on each matched row (see matcher.js) —
// kaprukaInStock is only trustworthy on runs re-checked against each
// product's own Kapruka page post-match (see hydrateKaprukaStock() in
// compare/run.js); the catalogue/storefront listing scrape alone reports
// every Kapruka product as in stock regardless of reality, so a partner
// needs a fresh run (after that hydration existed) before it can show up
// in the kapruka/both buckets.
export async function stockMismatchReport() {
  const partnerOutOfStock = [];
  const kaprukaOutOfStock = [];
  const bothOutOfStock = [];
  let lastUpdated = null;
  const removed = await cachedRemovedUrlSet();

  for (const { created_at, payload } of (await latestRunPerPartner()).values()) {
    const p = payload.partner || {};
    const at = payload.generatedAt || created_at;
    if (!lastUpdated || at > lastUpdated) lastUpdated = at;

    for (const m of payload.matched || []) {
      if (!m.kaprukaUrl || removed.has(m.kaprukaUrl)) continue;
      const kIn = m.kaprukaInStock !== false;
      const pIn = m.partnerInStock !== false;
      if (kIn && pIn) continue; // both in stock — not interesting

      const row = {
        partnerId: p.id ?? '',
        partner: p.name ?? '',
        partnerLabel: p.partnerLabel || p.partnerSite || '',
        category: categoryFromKaprukaUrl(m.kaprukaUrl),
        name: m.name ?? '',
        kaprukaPrice: m.kaprukaPrice ?? null,
        partnerPrice: m.partnerPrice ?? null,
        confidence: m.confidence ?? '',
        nameSimilarity: m.nameSimilarity ?? null,
        kaprukaUrl: m.kaprukaUrl ?? '',
        partnerUrl: m.partnerUrl ?? '',
        generatedAt: at,
      };
      if (!kIn && !pIn) bothOutOfStock.push(row);
      else if (kIn && !pIn) partnerOutOfStock.push(row);
      else kaprukaOutOfStock.push(row);
    }
  }

  return {
    lastUpdated,
    partnerOutOfStock,
    kaprukaOutOfStock,
    bothOutOfStock,
    counts: {
      partnerOutOfStock: partnerOutOfStock.length,
      kaprukaOutOfStock: kaprukaOutOfStock.length,
      bothOutOfStock: bothOutOfStock.length,
    },
  };
}

const STOCK_MISMATCH_COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'partner', label: 'Store' },
  { key: 'name', label: 'Product' },
  { key: 'kaprukaPrice', label: 'Kapruka price' },
  { key: 'partnerPrice', label: 'Partner price' },
  { key: 'confidence', label: 'Match confidence' },
  { key: 'nameSimilarity', label: 'Name similarity %' },
  { key: 'kaprukaUrl', label: 'Kapruka URL' },
  { key: 'partnerUrl', label: 'Partner URL' },
  { key: 'generatedAt', label: 'Updated at' },
];

// direction: 'partner' -> partnerOutOfStock, 'kapruka' -> kaprukaOutOfStock, 'both' -> bothOutOfStock.
export async function exportStockMismatchCsv(direction, partnerId = null, category = null) {
  const report = await stockMismatchReport();
  const items = direction === 'kapruka' ? report.kaprukaOutOfStock
    : direction === 'both' ? report.bothOutOfStock
    : report.partnerOutOfStock;
  const filtered = items.filter(
    (i) => (!partnerId || i.partnerId === partnerId) && (!category || i.category === category),
  );
  return buildCsv(STOCK_MISMATCH_COLUMNS, filtered);
}

// ---- All Products Overpriced dashboard --------------------------------------
// Same idea as overpricedReport(), but across EVERY product we have price data
// for, not just ones sold through a configured partner storefront. Merges two
// sources keyed by kaprukaUrl (both use the same /kid/<code> URL scheme, so a
// product genuinely covered by both lines up under one entry):
//   1. price_audit_items - the 5-category audit crawl (Electronics/Cosmetics/
//      Home & Lifestyle/Sports/Chocolates), one row per (Kapruka product,
//      competitor site) match.
//   2. comparison_runs - the configured-partner reconciliation tool. Per the
//      dashboard's design, a partner match is always surfaced as its own
//      field even when it isn't the single cheapest option, so "is this
//      product carried by one of our partners, and at what price" stays
//      answerable at a glance; every other site cheaper than Kapruka is
//      listed alongside it.
export async function allProductsOverpricedReport() {
  const products = new Map(); // kaprukaUrl -> { category, name, kaprukaPrice, partner, otherSites }

  function getOrCreate(url, category, name, price) {
    let p = products.get(url);
    if (!p) {
      p = { kaprukaUrl: url, category: category || 'Other', name: name || '', kaprukaPrice: price ?? null, partner: null, otherSites: [] };
      products.set(url, p);
    } else {
      if (!p.name && name) p.name = name;
      if (p.kaprukaPrice == null && price != null) p.kaprukaPrice = price;
      if (category && p.category === 'Other') p.category = category;
    }
    return p;
  }

  const removed = await cachedRemovedUrlSet();
  const auditRows = await cachedGetPriceAuditItems({ limit: 20000 });
  for (const r of auditRows) {
    if (!r.kapruka_url || !r.matched_url || r.matched_price_lkr == null) continue;
    const p = getOrCreate(r.kapruka_url, r.category, r.kapruka_name, r.kapruka_price_lkr);
    p.otherSites.push({
      name: r.site_name || r.site_domain,
      domain: r.site_domain,
      url: r.matched_url,
      price: r.matched_price_lkr,
    });
  }

  for (const { payload } of (await latestRunPerPartner()).values()) {
    const partnerName = payload.partner?.name || payload.partner?.partnerLabel || 'partner';
    for (const m of payload.matched || []) {
      if (!m.kaprukaUrl || !m.partnerUrl || m.partnerPrice == null) continue;
      const p = getOrCreate(m.kaprukaUrl, categoryFromKaprukaUrl(m.kaprukaUrl), m.name, m.kaprukaPrice);
      // First (or cheapest, if more than one partner somehow carries the same
      // product) partner match wins — each Kapruka product is normally only
      // carried by a single configured partner storefront.
      if (!p.partner || m.partnerPrice < p.partner.price) {
        p.partner = { name: partnerName, url: m.partnerUrl, price: m.partnerPrice };
      }
    }
  }

  const items = [];
  for (const p of products.values()) {
    if (p.kaprukaPrice == null) continue;
    // Team-curated exclusions — see removed_products in db.js.
    if (removed.has(p.kaprukaUrl)) continue;
    const candidates = [];
    if (p.partner) candidates.push({ type: 'partner', ...p.partner });
    for (const s of p.otherSites) candidates.push({ type: 'other', ...s });
    if (!candidates.length) continue;

    const best = candidates.reduce((a, b) => (b.price < a.price ? b : a));
    if (p.kaprukaPrice <= best.price) continue; // not overpriced

    const diff = p.kaprukaPrice - best.price;
    const otherSitesCheaper = candidates
      .filter((c) => c.type === 'other' && c.price < p.kaprukaPrice)
      .sort((a, b) => a.price - b.price);

    items.push({
      category: p.category,
      name: p.name,
      kaprukaUrl: p.kaprukaUrl,
      kaprukaPrice: p.kaprukaPrice,
      partner: p.partner, // always surfaced when the product has one, regardless of whether it's the cheapest
      partnerPrice: p.partner?.price ?? null, // flat convenience copy for table sorting
      otherSites: otherSitesCheaper,
      bestSource: best.type,
      bestName: best.name,
      bestUrl: best.url,
      bestPrice: best.price,
      diff,
      pct: (diff / best.price) * 100,
    });
  }

  items.sort((a, b) => b.diff - a.diff);
  return {
    count: items.length,
    totalOvercharge: items.reduce((sum, i) => sum + i.diff, 0),
    items,
  };
}

const ALL_OVERPRICED_COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'name', label: 'Product' },
  { key: 'kaprukaPrice', label: 'Kapruka price' },
  { key: 'partnerName', label: 'Partner' },
  { key: 'partnerPrice', label: 'Partner price' },
  { key: 'cheaperElsewhere', label: 'Cheaper elsewhere' },
  { key: 'bestPrice', label: 'Best price found' },
  { key: 'diff', label: 'Overcharge (Rs.)' },
  { key: 'pct_out', label: 'Overcharge %' },
  { key: 'kaprukaUrl', label: 'Kapruka URL' },
];

export async function exportAllProductsOverpricedCsv() {
  const { items } = await allProductsOverpricedReport();
  const rows = items.map((i) => ({
    category: i.category,
    name: i.name,
    kaprukaPrice: i.kaprukaPrice,
    partnerName: i.partner?.name ?? '',
    partnerPrice: i.partner?.price ?? '',
    cheaperElsewhere: i.otherSites.map((s) => `${s.name} Rs.${s.price}`).join('; '),
    bestPrice: i.bestPrice,
    diff: i.diff,
    pct_out: Math.round(i.pct * 10) / 10,
    kaprukaUrl: i.kaprukaUrl,
  }));
  return buildCsv(ALL_OVERPRICED_COLUMNS, rows);
}

// ---- Price Comparison: one row per matched Kapruka<->partner product pair ----

const COMPARISON_COLUMNS = [
  { key: 'run_id', label: 'Run ID' },
  { key: 'run_at', label: 'Run at' },
  { key: 'partner', label: 'Partner' },
  { key: 'partner_site', label: 'Partner site' },
  { key: 'platform', label: 'Platform' },
  { key: 'product', label: 'Kapruka product' },
  { key: 'kapruka_price', label: 'Kapruka price' },
  { key: 'partner_matched_name', label: 'Partner product' },
  { key: 'partner_price', label: 'Partner price' },
  { key: 'partner_regular_price', label: 'Partner regular price' },
  { key: 'kapruka_minus_partner', label: 'Kapruka − Partner' },
  { key: 'pct', label: 'Diff %' },
  { key: 'verdict', label: 'Verdict' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'name_similarity', label: 'Name similarity %' },
  { key: 'partner_sku', label: 'Partner SKU' },
  { key: 'kapruka_url', label: 'Kapruka URL' },
  { key: 'partner_url', label: 'Partner URL' },
];

// ---- Price Changes dashboard: competitor price moved between scrapes ------
// Compares each partner's two most recent stored comparison runs (the
// previous scrape vs the latest one) and flags every matched product where
// the PARTNER'S (competitor) price differs between those two runs — either
// up or down. Unlike overpricedReport()/stockMismatchReport(), which only
// ever look at the single latest run, this needs the run *before* it too, so
// it pulls per-partner via recentComparisonRuns(2, partnerId) + a
// getComparisonRun() fetch for each of those two payloads, rather than
// scanning the (potentially huge) allComparisonRows() table.
//
// Matched pairs are keyed by partnerUrl (stable across runs for the same
// partner product) since kaprukaUrl alone doesn't guarantee the matcher
// picked the same partner product both times, but partnerUrl does.
export async function priceChangesReport() {
  const removed = await removedUrlSet();
  const items = [];
  let partnersChecked = 0;
  let lastUpdated = null;

  const partners = await listPartners();
  for (const partner of partners) {
    const runs = await recentComparisonRuns(2, partner.id); // newest first
    if (runs.length < 2) continue;
    partnersChecked++;

    const [latest, previous] = await Promise.all([
      getComparisonRun(runs[0].id),
      getComparisonRun(runs[1].id),
    ]);
    if (!latest || !previous) continue;

    const at = latest.generatedAt || runs[0].created_at;
    if (!lastUpdated || at > lastUpdated) lastUpdated = at;

    const prevByUrl = new Map();
    for (const m of previous.matched || []) {
      if (m.partnerUrl && m.partnerPrice != null) prevByUrl.set(m.partnerUrl, m);
    }

    for (const m of latest.matched || []) {
      if (!m.partnerUrl || m.partnerPrice == null || !m.kaprukaUrl) continue;
      if (removed.has(m.kaprukaUrl)) continue;
      const prev = prevByUrl.get(m.partnerUrl);
      if (!prev || prev.partnerPrice == null) continue;
      if (prev.partnerPrice === m.partnerPrice) continue;

      const diff = m.partnerPrice - prev.partnerPrice;
      items.push({
        partnerId: partner.id,
        partner: partner.name,
        partnerLabel: partner.partnerLabel || partner.partnerSite || '',
        category: categoryFromKaprukaUrl(m.kaprukaUrl),
        name: m.name ?? '',
        partnerProductName: m.partnerName ?? '',
        direction: diff > 0 ? 'increased' : 'decreased',
        previousPrice: prev.partnerPrice,
        currentPrice: m.partnerPrice,
        diff,
        pct: (diff / prev.partnerPrice) * 100,
        kaprukaPrice: m.kaprukaPrice ?? null,
        kaprukaUrl: m.kaprukaUrl,
        partnerUrl: m.partnerUrl,
        previousScrapedAt: previous.generatedAt || runs[1].created_at,
        currentScrapedAt: at,
      });
    }
  }

  // Biggest absolute rupee move first.
  items.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const increased = items.filter((i) => i.direction === 'increased');
  const decreased = items.filter((i) => i.direction === 'decreased');

  return {
    lastUpdated,
    partnersChecked,
    partnersTotal: partners.length,
    count: items.length,
    increasedCount: increased.length,
    decreasedCount: decreased.length,
    totalIncrease: increased.reduce((sum, i) => sum + i.diff, 0),
    totalDecrease: decreased.reduce((sum, i) => sum + i.diff, 0),
    items,
  };
}

const PRICE_CHANGES_COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'partner', label: 'Store' },
  { key: 'name', label: 'Kapruka product' },
  { key: 'partnerProductName', label: 'Partner product' },
  { key: 'direction', label: 'Direction' },
  { key: 'previousPrice', label: 'Previous partner price' },
  { key: 'currentPrice', label: 'Current partner price' },
  { key: 'diff', label: 'Change (Rs.)' },
  { key: 'pct_out', label: 'Change %' },
  { key: 'kaprukaPrice', label: 'Current Kapruka price' },
  { key: 'previousScrapedAt', label: 'Previous scrape' },
  { key: 'currentScrapedAt', label: 'Latest scrape' },
  { key: 'kaprukaUrl', label: 'Kapruka URL' },
  { key: 'partnerUrl', label: 'Partner URL' },
];

export async function exportPriceChangesCsv(partnerId = null, direction = null) {
  const { items } = await priceChangesReport();
  const filtered = items.filter(
    (i) => (!partnerId || i.partnerId === partnerId) && (!direction || i.direction === direction),
  );
  const rows = filtered.map((i) => ({
    ...i,
    pct_out: i.pct != null ? Math.round(i.pct * 10) / 10 : '',
  }));
  return buildCsv(PRICE_CHANGES_COLUMNS, rows);
}

export async function exportComparisonCsv(partnerId = null) {
  const rows = [];
  for (const row of await allComparisonRows(partnerId)) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    const p = payload.partner || {};
    const meta = {
      run_id: row.id,
      run_at: row.created_at,
      partner: p.name ?? '',
      partner_site: p.partnerSite ?? '',
      platform: p.platform ?? '',
    };
    for (const m of payload.matched || []) {
      rows.push({
        ...meta,
        product: m.name ?? '',
        kapruka_price: m.kaprukaPrice ?? '',
        partner_matched_name: m.partnerName ?? '',
        partner_price: m.partnerPrice ?? '',
        partner_regular_price: m.partnerRegularPrice ?? '',
        kapruka_minus_partner: m.diff ?? '',
        pct: m.pct != null ? Math.round(m.pct * 10) / 10 : '',
        verdict: m.verdict ?? '',
        confidence: m.confidence ?? '',
        name_similarity: m.nameSimilarity ?? '',
        partner_sku: m.partnerSku ?? '',
        kapruka_url: m.kaprukaUrl ?? '',
        partner_url: m.partnerUrl ?? '',
      });
    }
  }
  return buildCsv(COMPARISON_COLUMNS, rows);
}
