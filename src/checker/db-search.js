// Price Checker: search the already-scraped/matched database for a typed
// product name (or one resolved from a pasted Kapruka URL) instead of
// live-scraping every query from scratch. The live web search (pipeline.js /
// runMatch) is NOT a fallback for this — both run on every search and their
// rows are merged into one table, see server.js's runCheckerSearch().
//
// Identity matching (scoreCandidate's token-containment check) still only
// ever looks at the product NAME — same convention as every other matcher
// in this codebase (match-local.js, retry-unmatched.js, matcher.js). A
// stray descriptive word ("with Apple Care") that isn't in a competitor's
// own product title would otherwise cause that strict containment check to
// reject an otherwise-correct match. The description IS used, but only in
// ways that can widen recall without weakening that precision check: mining
// it for a model/SKU code to add to the query's code set (see toIndexed()),
// and as a fallback source of SQL search tokens when the name alone finds
// nothing in competitor_products (see searchCompetitorProductsTable()). It's
// also still passed through to the live web search, where the LLM identity
// check can use it directly.
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
import { scoreCandidate, broadNameMatch } from '../compare/audit-scoring.js';
import { searchPrefixes, extractModelCodes, specsConflict, tokenSequence } from '../compare/normalize.js';
import { getPriceAuditItems, searchCompetitorProductsByTokens, allComparisonRows } from '../db.js';

const AUDIT_ITEMS_SCAN_LIMIT = 6000; // comfortably above the ~2.5k rows currently stored
const COMPETITOR_SEARCH_LIMIT = 500;

// price_audit_items/comparison_runs are full-table scans over PostgREST,
// paged in <=1000-row chunks — several network round trips EVERY checker
// search, even though the underlying data only changes when a nightly audit
// or partner-compare run writes to it (roughly once/day). That round-trip
// cost, repeated on every single query, was the main source of the "search
// takes too long" complaints. Cache the raw rows in memory for several hours
// so the whole day's worth of searches reuse one fetch instead of re-paging
// the whole table each time. A rejected fetch isn't cached, so the next call
// retries immediately rather than being stuck with a failure for the TTL.
const TABLE_CACHE_TTL_MS = 5 * 60 * 60 * 1000;
let auditItemsCache = null; // { at, promise }
let comparisonRowsCache = null; // { at, promise }

function getCachedPriceAuditItems() {
  const now = Date.now();
  if (!auditItemsCache || now - auditItemsCache.at >= TABLE_CACHE_TTL_MS) {
    const promise = getPriceAuditItems({ limit: AUDIT_ITEMS_SCAN_LIMIT });
    auditItemsCache = { at: now, promise };
    promise.catch(() => { auditItemsCache = null; });
  }
  return auditItemsCache.promise;
}

function getCachedComparisonRows() {
  const now = Date.now();
  if (!comparisonRowsCache || now - comparisonRowsCache.at >= TABLE_CACHE_TTL_MS) {
    const promise = allComparisonRows();
    comparisonRowsCache = { at: now, promise };
    promise.catch(() => { comparisonRowsCache = null; });
  }
  return comparisonRowsCache.promise;
}

// The strict identity search (scoreCandidate) needs >=2 shared distinctive
// words, and >=3 for a spec-less name — a bar a short query for a real
// product ("playstation 5", "ps5") can never clear, however well the
// catalogue actually covers it. The looser containment search
// (broadNameMatch) used to only run as a fallback for such queries, which is
// what made the answer depend on how the query was phrased: "Sony playstation
// 5" (3 tokens) took the strict path, "playstation 5" (2 tokens) took the
// broad one, and the two paths returned different sites. Both now ALWAYS run
// and their rows are unioned — see matchCandidate()/searchDatabase().
const MAX_MATCHED_PRODUCTS = 20;
// Ceiling on the merged table, so a very generic query ("iphone") can't
// return a thousand rows. Applied after sorting, so what's dropped is always
// the weakest/most expensive end of the list.
const MAX_RESULTS = 60;

// The checker's `k` side is a phrase a human typed, not a Kapruka product
// title, so at most one plain word they did or didn't type (typically the
// brand: "Sony") may be missing from a candidate. Numbers, SKUs and
// qualifier words are never waived — see audit-scoring.js's isWaivableWord.
const QUERY_WAIVE = 1;

// A word-containment match is real evidence but weaker than a scored
// identity match (no SKU agreement, no spec agreement behind it), so its
// reported match rate is scaled down rather than ever being shown as a
// verified 100% — a strict match always sorts above it.
const BROAD_MAX_RATE = 90;

// The ILIKE pre-filter that narrows competitor_products before anything is
// scored. Two separate searches, because the two kinds of anchor fail in
// opposite directions:
//   - the model code ("55a61h") finds the exact SKU wherever a site spells it
//     out, and nothing at all on the (very common) site that doesn't;
//   - the most distinctive plain WORDS ("hisense", "smart") find the terser
//     listing, and are what every code-less product has to rely on.
// They used to share one AND-ed query picking the two LONGEST words — which
// is the model code whenever the name carries one, so a Kapruka name ending
// in its SKU could only ever pre-filter to sites that quote that same SKU.
// Kapruka's own "Hisense A6 Series 55 Inch 4K UHD Smart TV 55A61H" therefore
// pulled back zero bigdeals.lk rows, no matter how well they'd have scored.
// Run both and merge instead; the code query only costs an extra round trip
// on names that actually carry a code.
//
// searchPrefixes() (not tokenize()) because these go into a SQL substring
// match against the stored product_name, where a singularized token like
// "sery"/"accessory" matches nothing at all. Specs ("128gb") are already
// excluded by searchPrefixes — too common across unrelated products to narrow
// anything usefully.
//
// The AND-ed word pair has the same flaw as the code query when one of those
// two words is a brand the listing doesn't print: "Sony playstation 5"
// pre-filtered on "playstation" AND "sony", so every shop that titles the
// console without "Sony" (nanotek, doctormobile, greenware) was invisible to
// that phrasing while "playstation 5" found them all — the same two-phrasings-
// two-answers bug, one layer down in the SQL. So the single most distinctive
// word is also run on its own, and the rows are merged.
const MAX_CODE_QUERIES = 2;
function searchQueries(name) {
  const codes = [...extractModelCodes(name)];
  const words = searchPrefixes(name)
    .filter((w) => !codes.includes(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  const queries = [];
  if (words.length) queries.push(words);
  if (words.length > 1) queries.push([words[0]]);
  for (const code of codes.slice(0, MAX_CODE_QUERIES)) queries.push([code]);
  return queries;
}

// Matching still only ever CONTAINS-checks the product NAME (see the file
// header) -- a stray descriptive word not on the competitor's own title
// would otherwise trip scoreCandidate's strict containment check and reject
// an otherwise-correct match. But a strong model/SKU code is different: it's
// never treated as noise (scoreCandidate's low-bar "codes >= 1" branch
// exists precisely because a shared code is stronger evidence than name
// overlap), and the code identifying a product is often only mentioned in
// its longer description, not the short name a user types/pastes. So fold
// codes extracted from the description into the query's code set (NOT its
// token set) -- this can only help a match go through the code path that
// name-only indexing would have missed, never make the containment check
// stricter.
function toIndexed(name, description = '') {
  const [row] = index([{ name, url: 'query' }], false);
  if (description) {
    for (const c of extractModelCodes(description)) row._codes.add(c);
  }
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

// matchKind 'strict' — scoreCandidate() accepted it: every distinctive word
//   the user typed is on the listing (bar one waivable plain word), specs
//   agree, no qualifier/accessory mismatch. Reported at its real overlap.
// matchKind 'broad'  — only broadNameMatch() accepted it: the words the user
//   typed are all present, but with no SKU/spec agreement behind it, so its
//   rate is capped at BROAD_MAX_RATE and it always sorts under a strict row.
function resultRow({ site, domain, title, url, price, matchRate, sourceTable, matchKind, via }) {
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
    matchKind: matchKind || 'strict',
    // Which Kapruka product this row was matched through, when the query
    // matched more than one (e.g. two different PS5 SKUs) — shown under the
    // listing so a merged table still says where each row came from.
    via: via || null,
  };
}

// Score one catalogue candidate against the query — strict first, broad
// second. The single place both bars are applied, so every table below
// decides "is this the product the user asked for" identically. Returns null,
// or { kind, rate, value }, where `value` ranks candidates against each other
// (a strict match always outranks a broad one).
function matchCandidate(qIndexed, cIndexed) {
  const sc = scoreCandidate(qIndexed, cIndexed, { waiveUnmatched: QUERY_WAIVE });
  if (sc) return { kind: 'strict', rate: Math.round(sc.overlap * 100), value: 10 + sc.value };
  // The strict path already vetoes conflicting specs; the broad one has to do
  // that itself, or "PlayStation 5 1TB" would match an 825GB listing purely
  // on the typed words all being present in its title.
  if (specsConflict(qIndexed._specs, cIndexed._specs)) return null;
  const bm = broadNameMatch(qIndexed._tokens, cIndexed._tokens, {
    waive: QUERY_WAIVE,
    // Position matters for a containment-only match — see leadsWithQuery().
    qSeq: tokenSequence(qIndexed.name),
    cSeq: tokenSequence(cIndexed.name),
  });
  if (!bm) return null;
  return { kind: 'broad', rate: Math.round(Math.min(BROAD_MAX_RATE, bm.overlap * 100)), value: bm.overlap };
}

// Table 1: price_audit_items — confirmed Kapruka<->competitor matches from
// the 5-category audit system. Returns EVERY Kapruka product the query
// matches (not just the single best one), each with all of its site matches:
// a query like "playstation 5" legitimately refers to more than one tracked
// SKU, and silently picking one of them is what let two phrasings of the same
// search answer with two different competitor sets.
async function searchPriceAuditProducts(qIndexed) {
  const rows = await getCachedPriceAuditItems();
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
    const m = matchCandidate(qIndexed, kIndexed);
    if (!m) continue;
    products.push({
      url: kaprukaUrl,
      name: group.name,
      price: group.price ?? null,
      matchRate: m.rate,
      matchKind: m.kind,
      value: m.value,
      // Fewer words beyond what was typed = closer to what was asked for;
      // breaks ties between two equally-scoring SKUs.
      extraTokens: kIndexed._tokens.size - qIndexed._tokens.size,
      results: group.rows
        .filter((r) => r.matched_url)
        .map((r) =>
          resultRow({
            site: r.site_name || r.site_domain,
            domain: r.site_domain,
            title: r.matched_name,
            url: r.matched_url,
            price: r.matched_price_lkr,
            // Two independent pieces of evidence: how much of the query the
            // Kapruka product accounts for, and how confident the STORED
            // audit match between that product and this listing was. A
            // medium/low-confidence audit row is discounted rather than
            // inheriting the query's own match rate wholesale.
            matchRate: Math.round(m.rate * (r.match_confidence === 'high' ? 1 : 0.8)),
            sourceTable: 'price_audit_items',
            matchKind: m.kind,
            via: group.name,
          }),
        ),
    });
  }

  products.sort((a, b) => b.value - a.value || a.extraTokens - b.extraTokens || a.name.localeCompare(b.name));
  return products.slice(0, MAX_MATCHED_PRODUCTS);
}

// Table 2: competitor_products — raw scraped catalogue, matched live.
async function searchCompetitorProductsTable(qIndexed, name, description = '') {
  const queries = searchQueries(name);
  if (!queries.length) return [];
  const byUrl = new Map();
  for (const rows of await Promise.all(
    queries.map((q) => searchCompetitorProductsByTokens(q, COMPETITOR_SEARCH_LIMIT)),
  )) {
    for (const r of rows) byUrl.set(`${r.site_domain}|${r.product_url}`, r);
  }
  // The name's own words/codes found nothing at the SQL level -- try again
  // with the description's most distinctive ones (e.g. a brand/model the
  // short "name" field left out). Only fired when the fast path is empty, so
  // the common case pays no extra round trip.
  if (!byUrl.size && description) {
    for (const rows of await Promise.all(
      searchQueries(description).map((q) => searchCompetitorProductsByTokens(q, COMPETITOR_SEARCH_LIMIT)),
    )) {
      for (const r of rows) byUrl.set(`${r.site_domain}|${r.product_url}`, r);
    }
  }
  const rows = [...byUrl.values()];
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

  // EVERY matching listing, not one "best" per shop. A shop genuinely stocks
  // several variants of what a short query asks for (a disc and a digital
  // PS5 at different prices), and keeping only one of them meant an arbitrary
  // tie-break decided which price that shop "had" — two phrasings of the same
  // query then showed two different prices for the same shop. The overall
  // list is capped (MAX_RESULTS) and sorted deterministically instead.
  const out = [];
  for (const c of indexed) {
    const m = matchCandidate(qIndexed, c);
    if (!m) continue;
    out.push(
      resultRow({
        site: c.siteName || c.siteDomain,
        domain: c.siteDomain,
        title: c.name,
        url: c.url,
        price: c.priceLKR,
        matchRate: m.rate,
        sourceTable: 'competitor_products',
        matchKind: m.kind,
      }),
    );
  }
  return out;
}

// Table 3: comparison_runs — the older single-partner tool's stored payloads.
async function searchComparisonRunsTable(qIndexed) {
  const rows = await getCachedComparisonRows();
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
      const match = matchCandidate(qIndexed, toIndexed(m.partnerName));
      if (!match) continue;
      const cur = bestPerPartner.get(partnerDomain);
      if (!cur || match.value > cur.match.value) {
        bestPerPartner.set(partnerDomain, { m, match, partnerName, partnerDomain });
      }
    }
  }

  return [...bestPerPartner.values()].map(({ m, match, partnerName, partnerDomain }) =>
    resultRow({
      site: partnerName,
      domain: partnerDomain,
      title: m.partnerName,
      url: m.partnerUrl,
      price: m.partnerPrice,
      matchRate: match.rate,
      sourceTable: 'comparison_runs',
      matchKind: match.kind,
    }),
  );
}

// One row per LISTING (site + product page), not per site: the same shop can
// legitimately carry two of the SKUs a short query covers, and collapsing
// those to one row hides a real price. Within one listing, the strongest
// evidence wins — a strict match over a broad one, then the higher match
// rate, then price_audit_items (a reviewed audit match) over
// competitor_products (scored live against the raw catalogue) over
// comparison_runs (the older tool). Exported so server.js can run the same
// de-duplication across the database rows AND the live web-search rows.
const TABLE_RANK = { price_audit_items: 3, competitor_products: 2, comparison_runs: 1 };
function listingKey(r) {
  const url = String(r.url || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  return `${r.domain || r.site || ''}|${url || String(r.title || '').toLowerCase()}`;
}
// Second key, for the same shop listing the same product twice under two
// URLs (a duplicated catalogue entry) — same site, same title, same price is
// one listing however many URLs point at it.
function productKey(r) {
  return `${r.domain || r.site || ''}|${String(r.title || '').trim().toLowerCase()}|${r.price ?? ''}`;
}
function rowStrength(r) {
  return (r.matchKind === 'broad' ? 0 : 1000) + (r.matchRate || 0) * 10 + (TABLE_RANK[r.sourceTable] || 0);
}
export function mergeListings(...lists) {
  const byListing = new Map();
  for (const list of lists) {
    for (const r of list) {
      if (!r) continue;
      const key = listingKey(r);
      const cur = byListing.get(key);
      if (!cur || rowStrength(r) > rowStrength(cur)) byListing.set(key, r);
    }
  }
  const byProduct = new Map();
  for (const r of byListing.values()) {
    const key = productKey(r);
    const cur = byProduct.get(key);
    if (!cur || rowStrength(r) > rowStrength(cur)) byProduct.set(key, r);
  }
  return [...byProduct.values()];
}

// Strongest match first, then usable rows before flagged ones, then cheapest.
// The final domain/URL tie-break isn't cosmetic: without it, equally-scoring
// rows come out in whatever order the database happened to return them, which
// is exactly the kind of thing that made the same search look different twice.
export function byBestValue(a, b) {
  if ((b.matchRate || 0) !== (a.matchRate || 0)) return (b.matchRate || 0) - (a.matchRate || 0);
  const aOk = a.status === 'ok' ? 0 : 1;
  const bOk = b.status === 'ok' ? 0 : 1;
  if (aOk !== bOk) return aOk - bOk;
  if ((a.price ?? Infinity) !== (b.price ?? Infinity)) return (a.price ?? Infinity) - (b.price ?? Infinity);
  return String(a.domain || a.site || '').localeCompare(String(b.domain || b.site || ''))
    || String(a.url || '').localeCompare(String(b.url || ''));
}

/**
 * Every database row matching the query, from all 3 tables, in one flat list.
 * There is deliberately no "mode" any more: a query either finds rows or it
 * doesn't, and the caller unions these with the live web search either way
 * (see server.js's runCheckerSearch). Returns:
 *   results           - de-duplicated listings, strongest match first
 *   kaprukaRef        - best-matching Kapruka product (for the price insight)
 *   kaprukaCandidates - EVERY Kapruka product the query matched, so the UI can
 *                       say plainly that more than one SKU is involved instead
 *                       of silently answering about one of them.
 */
export async function searchDatabase({ name, description }) {
  const cleanName = String(name || '').trim();
  const cleanDescription = String(description || '').trim();
  if (!cleanName) return { hasMatch: false, results: [], kaprukaRef: null, kaprukaCandidates: [] };
  const qIndexed = toIndexed(cleanName, cleanDescription);

  const [auditProducts, competitorResults, comparisonResults] = await Promise.all([
    searchPriceAuditProducts(qIndexed),
    searchCompetitorProductsTable(qIndexed, cleanName, cleanDescription),
    searchComparisonRunsTable(qIndexed),
  ]);

  const auditResults = auditProducts.flatMap((p) => p.results);
  const results = mergeListings(auditResults, competitorResults, comparisonResults)
    .sort(byBestValue)
    .slice(0, MAX_RESULTS);
  const kaprukaCandidates = auditProducts.map((p) => ({
    url: p.url,
    name: p.name,
    price: p.price,
    matchRate: p.matchRate,
  }));
  const best = auditProducts[0] || null;
  return {
    hasMatch: results.length > 0,
    results,
    kaprukaRef: best ? { url: best.url, name: best.name, price: best.price } : null,
    kaprukaCandidates,
  };
}
