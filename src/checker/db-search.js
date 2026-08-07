// Price Checker: search the already-scraped/matched database for a typed
// product name (or one resolved from a pasted Kapruka URL) instead of
// live-scraping every query from scratch. Live web search (pipeline.js /
// runMatch) is only used as a fallback when nothing here clears the match
// bar — see server.js.
//
// Matching only ever looks at the product NAME (never the description) —
// same convention as every other matcher in this codebase (match-local.js,
// retry-unmatched.js, matcher.js). The description is still shown in the UI
// and still passed through to the live-search fallback, where the LLM
// identity check can use it; it's just not part of this cheap DB pre-filter,
// since a stray descriptive word ("with Apple Care") that isn't in a
// competitor's own product title would otherwise cause scoreCandidate's
// strict token-containment check to reject an otherwise-correct match.
//
// Scans 3 tables:
//   1. price_audit_items  - confirmed Kapruka<->competitor matches from the
//      5-category audit system (electronics/cosmetics/home-lifestyle/sports/
//      chocolates). A hit here returns EVERY site matched for that Kapruka
//      product in one shot — already a ready-made multi-site comparison.
//   2. competitor_products - the same audit system's raw scraped catalogue
//      (every site, every category) — narrowed with an ILIKE token search,
//      then scored locally with scoreCandidate(). Covers products that were
//      crawled but never got a confirmed audit match.
//   3. comparison_runs - the older single-partner comparison tool's stored
//      payloads (one row per partner, each holding a `matched` array of
//      Kapruka<->partner pairs). Covers partners tracked there but not in
//      the newer audit tables.

import { index } from '../compare/matcher.js';
import { scoreCandidate } from '../compare/audit-scoring.js';
import { tokenize, SPEC_TOKEN } from '../compare/normalize.js';
import { getPriceAuditItems, searchCompetitorProductsByTokens, allComparisonRows } from '../db.js';

const AUDIT_ITEMS_SCAN_LIMIT = 6000; // comfortably above the ~2.5k rows currently stored
const COMPETITOR_SEARCH_LIMIT = 500;
// scoreCandidate() requires >=2 shared distinctive words before it'll even
// consider a candidate (MIN_INTERSECTION in audit-scoring.js) — a query with
// fewer words than that can never clear it, no matter how many products
// actually match (e.g. "iphone" alone can't score >=2 against ANY name).
// Below this token count, if the strict identity search finds nothing, fall
// through to the looser "browse" search instead of straight to live web
// search — see searchDatabase().
const BROAD_QUERY_MAX_TOKENS = 2;
const MAX_BROAD_PRODUCTS = 20;

// The most distinctive (longest, non-spec) tokens anchor the ILIKE search —
// specs like "128gb" are too common across unrelated products to narrow
// anything usefully.
function searchTokens(name) {
  const all = [...tokenize(name)].filter((t) => !SPEC_TOKEN.test(t));
  all.sort((a, b) => b.length - a.length);
  return all.slice(0, 2);
}

function toIndexed(name) {
  const [row] = index([{ name, url: 'query' }], false);
  return row;
}

function domainFromUrl(u) {
  if (!u) return null;
  try {
    return new URL(u.startsWith('http') ? u : `https://${u}`).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function resultRow({ site, domain, title, url, price, matchRate, sourceTable }) {
  return {
    site,
    domain,
    title,
    url,
    price: price ?? null,
    currency: 'LKR',
    matchRate,
    status: price == null ? 'price_not_found' : 'ok',
    source: 'database',
    sourceTable,
  };
}

// Table 1: price_audit_items — identify which (if any) already-audited
// Kapruka product the query refers to, then return all of its site matches.
async function searchPriceAuditItems(qIndexed) {
  const rows = await getPriceAuditItems({ limit: AUDIT_ITEMS_SCAN_LIMIT });
  if (!rows.length) return [];

  const byKapruka = new Map();
  for (const r of rows) {
    if (!r.kapruka_url || !r.kapruka_name) continue;
    if (!byKapruka.has(r.kapruka_url)) byKapruka.set(r.kapruka_url, { name: r.kapruka_name, rows: [] });
    byKapruka.get(r.kapruka_url).rows.push(r);
  }

  let best = null;
  for (const group of byKapruka.values()) {
    const kIndexed = toIndexed(group.name);
    const sc = scoreCandidate(qIndexed, kIndexed);
    if (sc && (!best || sc.value > best.sc.value)) best = { group, sc };
  }
  if (!best) return [];

  return best.group.rows
    .filter((r) => r.matched_url)
    .map((r) =>
      resultRow({
        site: r.site_name || r.site_domain,
        domain: r.site_domain,
        title: r.matched_name,
        url: r.matched_url,
        price: r.matched_price_lkr,
        matchRate: Math.round(best.sc.overlap * 100),
        sourceTable: 'price_audit_items',
      }),
    );
}

// Broad/browse search — used only when the strict identity search above
// finds nothing AND the query is short enough that it plausibly couldn't
// (see BROAD_QUERY_MAX_TOKENS). Deliberately much looser than
// scoreCandidate(): "does every word the user typed appear in this
// product's name" is a relevance filter, not an identity check, so a
// generic query like "iphone" surfaces every audited iPhone product instead
// of matching none. Only draws from price_audit_items, since that's the one
// source that's already cleanly grouped into (product, site-matches) —
// competitor_products/comparison_runs have no equivalent per-product
// grouping to browse by.
function broadTokenMatch(queryTokens, candidateTokens) {
  for (const t of queryTokens) {
    if (!candidateTokens.has(t)) return false;
  }
  return true;
}

async function searchPriceAuditItemsBroad(qIndexed) {
  const rows = await getPriceAuditItems({ limit: AUDIT_ITEMS_SCAN_LIMIT });
  if (!rows.length) return [];

  const byKapruka = new Map();
  for (const r of rows) {
    if (!r.kapruka_url || !r.kapruka_name) continue;
    if (!byKapruka.has(r.kapruka_url)) {
      byKapruka.set(r.kapruka_url, { name: r.kapruka_name, price: r.kapruka_price_lkr, rows: [] });
    }
    byKapruka.get(r.kapruka_url).rows.push(r);
  }

  const products = [];
  for (const [kaprukaUrl, group] of byKapruka) {
    const kIndexed = toIndexed(group.name);
    if (!broadTokenMatch(qIndexed._tokens, kIndexed._tokens)) continue;
    products.push({
      name: group.name,
      url: kaprukaUrl,
      kaprukaPrice: group.price,
      extraTokens: kIndexed._tokens.size - qIndexed._tokens.size, // fewer extra words = closer to what was typed
      results: group.rows
        .filter((r) => r.matched_url)
        .map((r) =>
          resultRow({
            site: r.site_name || r.site_domain,
            domain: r.site_domain,
            title: r.matched_name,
            url: r.matched_url,
            price: r.matched_price_lkr,
            // No scoreCandidate ran here (that's what "broad" means) — the
            // confidence that IS meaningful is the original audit match's
            // own confidence, carried over rather than fabricating a number.
            matchRate: r.match_confidence === 'high' ? 95 : 70,
            sourceTable: 'price_audit_items',
          }),
        )
        .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)),
    });
  }

  products.sort((a, b) => a.extraTokens - b.extraTokens || a.name.localeCompare(b.name));
  return products.slice(0, MAX_BROAD_PRODUCTS).map(({ extraTokens, ...p }) => p);
}

// Table 2: competitor_products — raw scraped catalogue, matched live.
async function searchCompetitorProductsTable(qIndexed, name) {
  const tokens = searchTokens(name);
  if (!tokens.length) return [];
  const rows = await searchCompetitorProductsByTokens(tokens, COMPETITOR_SEARCH_LIMIT);
  if (!rows.length) return [];

  const indexed = index(
    rows.map((r) => ({
      name: r.product_name,
      url: r.product_url,
      priceLKR: r.price_lkr,
      siteDomain: r.site_domain,
      siteName: r.site_name,
    })),
    false,
  );

  const bestPerSite = new Map();
  for (const c of indexed) {
    const sc = scoreCandidate(qIndexed, c);
    if (!sc) continue;
    const cur = bestPerSite.get(c.siteDomain);
    if (!cur || sc.value > cur.sc.value) bestPerSite.set(c.siteDomain, { c, sc });
  }

  return [...bestPerSite.values()].map(({ c, sc }) =>
    resultRow({
      site: c.siteName || c.siteDomain,
      domain: c.siteDomain,
      title: c.name,
      url: c.url,
      price: c.priceLKR,
      matchRate: Math.round(sc.overlap * 100),
      sourceTable: 'competitor_products',
    }),
  );
}

// Table 3: comparison_runs — the older single-partner tool's stored payloads.
async function searchComparisonRunsTable(qIndexed) {
  const rows = await allComparisonRows();
  if (!rows.length) return [];

  const bestPerPartner = new Map();
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    const partnerName = payload.partner?.name || payload.partner?.partnerLabel || 'partner';
    const partnerDomain = domainFromUrl(payload.partner?.partnerSite) || partnerName;
    for (const m of payload.matched || []) {
      if (!m.partnerName || !m.partnerUrl) continue;
      const sc = scoreCandidate(qIndexed, toIndexed(m.partnerName));
      if (!sc) continue;
      const cur = bestPerPartner.get(partnerDomain);
      if (!cur || sc.value > cur.sc.value) bestPerPartner.set(partnerDomain, { m, sc, partnerName, partnerDomain });
    }
  }

  return [...bestPerPartner.values()].map(({ m, sc, partnerName, partnerDomain }) =>
    resultRow({
      site: partnerName,
      domain: partnerDomain,
      title: m.partnerName,
      url: m.partnerUrl,
      price: m.partnerPrice,
      matchRate: Math.round(sc.overlap * 100),
      sourceTable: 'comparison_runs',
    }),
  );
}

// One row per site domain — price_audit_items (human-reviewed audit match)
// wins over competitor_products (live-scored against the raw catalogue),
// which wins over comparison_runs (the older tool), when more than one
// source has a candidate for the same domain.
function mergeByDomain(...lists) {
  const byDomain = new Map();
  for (const list of lists) {
    for (const r of list) {
      if (!byDomain.has(r.domain)) byDomain.set(r.domain, r);
    }
  }
  return [...byDomain.values()];
}

function byBestValue(a, b) {
  if ((b.matchRate || 0) !== (a.matchRate || 0)) return (b.matchRate || 0) - (a.matchRate || 0);
  return (a.price ?? Infinity) - (b.price ?? Infinity);
}

export async function searchDatabase({ name }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return { hasMatch: false, mode: null };
  const qIndexed = toIndexed(cleanName);

  // 1) Strict identity search — unchanged behavior for a well-specified
  // query: merges all 3 tables into one product's site-by-site comparison.
  const [auditResults, competitorResults, comparisonResults] = await Promise.all([
    searchPriceAuditItems(qIndexed),
    searchCompetitorProductsTable(qIndexed, cleanName),
    searchComparisonRunsTable(qIndexed),
  ]);
  const merged = mergeByDomain(auditResults, competitorResults, comparisonResults).sort(byBestValue);
  if (merged.length > 0) {
    return { hasMatch: true, mode: 'single', results: merged };
  }

  // 2) Broad/browse fallback — only reached for a short, generic query where
  // the strict search structurally never had a chance (see
  // BROAD_QUERY_MAX_TOKENS). Returns multiple products instead of one.
  if (qIndexed._tokens.size > 0 && qIndexed._tokens.size <= BROAD_QUERY_MAX_TOKENS) {
    const products = await searchPriceAuditItemsBroad(qIndexed);
    if (products.length > 0) {
      return { hasMatch: true, mode: 'browse', products };
    }
  }

  return { hasMatch: false, mode: null };
}
