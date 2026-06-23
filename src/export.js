// CSV exporters for the saved scrape data. Each stored run holds a full JSON
// payload (see db.js); here we flatten those payloads into one spreadsheet row
// per scraped product so the data opens cleanly in Excel / Google Sheets.
//
// A UTF-8 BOM is prepended so Excel renders Sri Lankan/Unicode product names
// correctly instead of mojibake.

import { allPriceCheckRows, allComparisonRows } from './db.js';

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
  for (const row of await allPriceCheckRows()) {
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
  for (const r of await allPriceCheckRows()) {
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
  for (const r of await allComparisonRows()) {
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
