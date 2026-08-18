// Persistence for both tools. Three backends behind one async API:
//
//   • Postgres (Supabase, direct wire protocol) — used when DATABASE_URL is
//     set. Fastest, but needs outbound access to port 5432/6543, which some
//     networks firewall off.
//   • Supabase REST (PostgREST over HTTPS) — used when SUPABASE_URL and
//     SUPABASE_SERVICE_KEY are set (and DATABASE_URL isn't). Same Supabase
//     database, reached over plain HTTPS/443 instead of a raw DB port, so it
//     works through firewalls that block direct Postgres connections. The
//     two tables below must already exist (PostgREST can't run DDL) — see
//     the CREATE TABLE block further down; run it once in the Supabase SQL
//     Editor.
//   • SQLite (node:sqlite) — local fallback when neither is configured, so
//     development needs no database setup. Portable file at data/price-tools.db.
//
// Tables:
//   price_checks        - one row per Price Checker query (/api/match)
//   comparison_runs     - one row per partner reconciliation that actually recomputed
//   partners            - the partner registry (name, Kapruka link, partner site,
//                         platform). Used to live in config/partners.json — moved
//                         here because that file is per-machine, so one instance
//                         adding a partner was invisible to any other instance
//                         until someone manually git-synced the file. A shared
//                         table means every instance always sees the same list.
//   intl_gift_pairings  - one row per (country, Kapruka SKU) -> matching URL on that
//                         country's competitor site (International Gifting Price
//                         Checker). Once a pairing is confirmed (auto-matched or
//                         manually set), it's cached here so future refreshes fetch
//                         that exact competitor product page directly instead of
//                         re-crawling/re-matching against the competitor's catalog.
//   unsupported_partners - append-only log of partner-site requests that couldn't
//                         be added automatically (no WooCommerce/Shopify catalogue
//                         found, or the site blocks automated requests). Nothing
//                         reads this at runtime; it's a worklist for building
//                         one-off custom scrapers for these sites later.
//   bulk_refresh_log   - append-only log of "Refresh all stores" clicks, one row
//                         per click (from any instance). Lets the server enforce
//                         a daily cap on the bulk-refresh button regardless of
//                         which host it was clicked from — see BULK_REFRESH_
//                         DAILY_LIMIT in src/server.js.
//   price_audit_items  - one row per (Kapruka product, competitor site) pair from
//                         the local product-price audit (src/electronics-audit/).
//                         Unlike comparison_runs (one partner's full catalogue vs
//                         Kapruka's), this audits MANY competitor sites at once by
//                         querying each site's own search endpoint per product, so
//                         results land here incrementally, one upsert per pair,
//                         rather than one big payload per run.
//   competitor_products - a competitor site's own FULL catalogue (not just what
//                         turned up in a per-product search) — crawled once per
//                         site and cached here so future audits can match against
//                         this local table instead of live-searching every
//                         product, same idea as the UAE checker's fnp.ae catalog
//                         crawl. Bulk-upserted per site (many rows per call).
//   removed_products   - team-curated exclusion list, keyed by kapruka_url. A
//                         product lands here when someone manually dismisses it
//                         from one of the overpriced dashboards (e.g. the
//                         partner's price is higher for a legitimate reason,
//                         like a bundled add-on). Every report that surfaces
//                         overpriced items (overpricedReport, all-products
//                         report, and the per-partner /api/compare matched
//                         list) filters these out by kaprukaUrl; the Removed
//                         Products card view on each dashboard reads this same
//                         table so a removal made from any page is reflected
//                         everywhere, and can be undone (restored) from any page.
//
// Each row keeps flat summary columns for easy SQL plus a full JSON payload so
// nothing is lost. ALL exported functions are async (Postgres/REST are async;
// the SQLite path resolves immediately).

import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const nowIso = () => new Date().toISOString();

// Pick the backend once at load. If SUPABASE_URL/SUPABASE_SERVICE_KEY are set
// but the host is unreachable (wrong project ref, deleted project, DNS/network
// issue), every request would otherwise fail forever with a bare "fetch
// failed". Probe it once and fall back to local SQLite instead, so a stale
// config value degrades the app rather than breaking it.
async function selectBackend() {
  if (DATABASE_URL) return { backend: await makePostgresBackend(DATABASE_URL), kind: 'postgres' };
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const rest = await makeSupabaseRestBackend(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    // A single transient network hiccup shouldn't silently strand a whole
    // crawl's data in a separate local SQLite file that other processes
    // reading via Supabase would never see — retry once before falling back.
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await rest.recentComparisonRuns(1);
        return { backend: rest, kind: 'supabase-rest' };
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    console.warn(`! Supabase REST unreachable (${lastErr.message}); falling back to local SQLite.`);
  }
  return { backend: await makeSqliteBackend(), kind: 'sqlite' };
}

const { backend, kind: storageKind } = await selectBackend();
export { storageKind };

// Shared shape for a removed-product row from the Postgres/Supabase-REST
// backends, where `snapshot` is a JSONB/json column the driver already hands
// back parsed. SQLite stores it as a TEXT column (snapshot_json) instead and
// maps its rows separately, inline, where it's read.
function rowToRemoved(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    kaprukaUrl: r.kapruka_url,
    name: r.name || '',
    category: r.category || '',
    partnerName: r.partner_name || '',
    reason: r.reason || '',
    removedBy: r.removed_by || '',
    sourcePage: r.source_page || '',
    snapshot: r.snapshot || null,
  };
}

// Shared shape for a discovered-site row across all three backends.
function rowToDiscoveredSite(r) {
  return {
    id: r.id,
    domain: r.domain,
    category: r.category || '',
    sampleUrl: r.sample_url || '',
    sampleQuery: r.sample_query || '',
    timesSeen: r.times_seen,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    status: r.status,
  };
}

// Shared shape for a partner row across all three backends.
function rowToPartner(r) {
  return {
    id: r.id,
    name: r.name,
    kaprukaUrl: r.kapruka_url || undefined,
    kaprukaSlug: r.kapruka_slug || undefined,
    partnerSite: r.partner_site,
    partnerLabel: r.partner_label || undefined,
    platform: r.platform || undefined,
    viaBrowser: !!r.via_browser,
    refreshRequestedAt: r.refresh_requested_at || null,
  };
}

export const savePriceCheck = (args) => backend.savePriceCheck(args);
export const saveComparisonRun = (data) => backend.saveComparisonRun(data);
export const recentPriceChecks = (limit = 50) => backend.recentPriceChecks(limit);
export const recentComparisonRuns = (limit = 50, partnerId = null) =>
  backend.recentComparisonRuns(limit, partnerId);
export const getComparisonRun = (id) => backend.getComparisonRun(id);
export const allPriceCheckRows = () => backend.allPriceCheckRows();
export const requestPartnerRefresh = (id) => backend.requestPartnerRefresh(id);
export const allComparisonRows = (partnerId = null) => backend.allComparisonRows(partnerId);
export const listPartnerRows = () => backend.listPartnerRows();
export const getPartnerRow = (id) => backend.getPartnerRow(id);
export const insertPartnerRow = (p) => backend.insertPartnerRow(p);
export const getIntlGiftPairings = (country) => backend.getIntlGiftPairings(country);
export const setIntlGiftPairing = (country, sku, fnpUrl, matchSource, matchConfidence) =>
  backend.setIntlGiftPairing(country, sku, fnpUrl, matchSource, matchConfidence);
// Latest full comparison result per country — written by the GitHub Actions
// refresh job, read directly by the static dashboard (public Supabase anon
// key, read-only via RLS). See public/uae-compare/index.html.
export const getIntlGiftSnapshot = (country) => backend.getIntlGiftSnapshot(country);
export const setIntlGiftSnapshot = (country, payload) => backend.setIntlGiftSnapshot(country, payload);
export const listUnsupportedPartners = () => backend.listUnsupportedPartners();
export const addUnsupportedPartner = (row) => backend.addUnsupportedPartner(row);
// Daily cap on the "Refresh all stores" button — see BULK_REFRESH_DAILY_LIMIT
// in src/server.js. sinceIso marks the start of "today" in whatever timezone
// the caller cares about (Sri Lanka time, for the business-day boundary).
export const countBulkRefreshesSince = (sinceIso) => backend.countBulkRefreshesSince(sinceIso);
export const logBulkRefreshRequest = () => backend.logBulkRefreshRequest();
export const upsertPriceAuditItem = (item) => backend.upsertPriceAuditItem(item);
export const getPriceAuditItems = (opts) => backend.getPriceAuditItems(opts);
export const deletePriceAuditItemsByCategory = (category) => backend.deletePriceAuditItemsByCategory(category);
export const upsertCompetitorProducts = (siteDomain, products, category) => backend.upsertCompetitorProducts(siteDomain, products, category);
export const getCompetitorProducts = (siteDomain) => backend.getCompetitorProducts(siteDomain);
// Cross-site substring search over the full competitor_products catalogue —
// used by the Price Checker to find candidates for a typed name/description
// without having to page through and score all ~70k+ cached rows locally.
// `tokens` are ANDed (every token must appear somewhere in product_name).
export const searchCompetitorProductsByTokens = (tokens, limit = 500) =>
  backend.searchCompetitorProductsByTokens(tokens, limit);
export const listRemovedProducts = () => backend.listRemovedProducts();
export const addRemovedProduct = (row) => backend.addRemovedProduct(row);
export const deleteRemovedProduct = (id) => backend.deleteRemovedProduct(id);
// Convenience for callers that just need to filter items by kaprukaUrl (every
// overpriced report) — avoids each caller re-deriving a Set from the full row list.
export async function removedUrlSet() {
  const rows = await listRemovedProducts();
  return new Set(rows.map((r) => r.kaprukaUrl));
}

// Domains the web-search discovery step keeps turning up that aren't yet a
// curated category site — a review queue (see discovered-sites.html) so a
// human decides whether to promote one to the permanent scrape list, rather
// than it happening automatically.
export const upsertDiscoveredSite = (row) => backend.upsertDiscoveredSite(row);
export const listDiscoveredSites = (status) => backend.listDiscoveredSites(status);
export const setDiscoveredSiteStatus = (id, status) => backend.setDiscoveredSiteStatus(id, status);

// ---------------------------------------------------------------------------
// Postgres (Supabase) backend
// ---------------------------------------------------------------------------

async function makePostgresBackend(connectionString) {
  const pg = (await import('pg')).default;
  // Supabase requires SSL; rejectUnauthorized:false avoids local CA issues.
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_checks (
      id               BIGSERIAL PRIMARY KEY,
      created_at       TEXT NOT NULL,
      category         TEXT,
      query_name       TEXT,
      description      TEXT,
      result_count     INTEGER,
      discovered_count INTEGER,
      payload          JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comparison_runs (
      id             BIGSERIAL PRIMARY KEY,
      created_at     TEXT NOT NULL,
      partner_id     TEXT,
      partner_name   TEXT,
      kapruka_slug   TEXT,
      partner_site   TEXT,
      platform       TEXT,
      kapruka_count  INTEGER,
      partner_count  INTEGER,
      matched        INTEGER,
      kapruka_higher INTEGER,
      kapruka_lower  INTEGER,
      same_price     INTEGER,
      only_kapruka   INTEGER,
      only_partner   INTEGER,
      payload        JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_partner ON comparison_runs (partner_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_checks_name ON price_checks (query_name, created_at);
    CREATE TABLE IF NOT EXISTS partners (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      kapruka_url           TEXT,
      kapruka_slug          TEXT,
      partner_site          TEXT NOT NULL,
      partner_label         TEXT,
      platform              TEXT,
      via_browser           BOOLEAN DEFAULT false,
      created_at            TEXT NOT NULL,
      refresh_requested_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS intl_gift_pairings (
      id                BIGSERIAL PRIMARY KEY,
      country           TEXT NOT NULL,
      kapruka_sku       TEXT NOT NULL,
      fnp_url           TEXT NOT NULL,
      match_source      TEXT,
      match_confidence  TEXT,
      updated_at        TEXT NOT NULL,
      UNIQUE (country, kapruka_sku)
    );
    CREATE TABLE IF NOT EXISTS intl_gift_snapshots (
      id             BIGSERIAL PRIMARY KEY,
      country        TEXT NOT NULL UNIQUE,
      generated_at   TEXT NOT NULL,
      payload        JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unsupported_partners (
      id            BIGSERIAL PRIMARY KEY,
      created_at    TEXT NOT NULL,
      name          TEXT,
      kapruka_url   TEXT,
      partner_site  TEXT NOT NULL,
      reason        TEXT,
      detail        TEXT
    );
    CREATE TABLE IF NOT EXISTS bulk_refresh_log (
      id            BIGSERIAL PRIMARY KEY,
      requested_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_audit_items (
      id                 BIGSERIAL PRIMARY KEY,
      category           TEXT NOT NULL,
      kapruka_url        TEXT NOT NULL,
      kapruka_name       TEXT,
      kapruka_price_lkr  INTEGER,
      site_domain        TEXT NOT NULL,
      site_name          TEXT,
      matched_url        TEXT,
      matched_name       TEXT,
      matched_price_lkr  INTEGER,
      match_confidence   TEXT,
      shared_codes       INTEGER,
      name_similarity    INTEGER,
      diff_lkr           INTEGER,
      diff_pct           NUMERIC,
      checked_at         TEXT NOT NULL,
      UNIQUE (kapruka_url, site_domain)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_category ON price_audit_items (category, checked_at);
    CREATE INDEX IF NOT EXISTS idx_audit_kapruka_url ON price_audit_items (kapruka_url);
    CREATE TABLE IF NOT EXISTS competitor_products (
      id            BIGSERIAL PRIMARY KEY,
      site_domain   TEXT NOT NULL,
      site_name     TEXT,
      product_url   TEXT NOT NULL,
      product_name  TEXT,
      price_lkr     INTEGER,
      scraped_at    TEXT NOT NULL,
      category      TEXT,
      UNIQUE (site_domain, product_url)
    );
    CREATE INDEX IF NOT EXISTS idx_competitor_products_site ON competitor_products (site_domain);
    CREATE INDEX IF NOT EXISTS idx_competitor_products_category ON competitor_products (category);
    CREATE TABLE IF NOT EXISTS removed_products (
      id            BIGSERIAL PRIMARY KEY,
      created_at    TEXT NOT NULL,
      kapruka_url   TEXT NOT NULL UNIQUE,
      name          TEXT,
      category      TEXT,
      partner_name  TEXT,
      reason        TEXT NOT NULL,
      removed_by    TEXT,
      source_page   TEXT,
      snapshot      JSONB
    );
    ALTER TABLE removed_products ADD COLUMN IF NOT EXISTS removed_by TEXT;
    CREATE TABLE IF NOT EXISTS discovered_sites (
      id            BIGSERIAL PRIMARY KEY,
      domain        TEXT NOT NULL UNIQUE,
      category      TEXT,
      sample_url    TEXT,
      sample_query  TEXT,
      times_seen    INTEGER NOT NULL DEFAULT 1,
      first_seen    TEXT NOT NULL,
      last_seen     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
    );
  `);

  return {
    async listRemovedProducts() {
      const { rows } = await pool.query(`SELECT * FROM removed_products ORDER BY created_at DESC`);
      return rows.map(rowToRemoved);
    },

    async upsertDiscoveredSite({ domain, category, sampleUrl, sampleQuery }) {
      const now = nowIso();
      await pool.query(
        `INSERT INTO discovered_sites (domain, category, sample_url, sample_query, times_seen, first_seen, last_seen, status)
         VALUES ($1,$2,$3,$4,1,$5,$5,'pending')
         ON CONFLICT (domain) DO UPDATE SET
           times_seen = discovered_sites.times_seen + 1, last_seen = EXCLUDED.last_seen,
           category = COALESCE(discovered_sites.category, EXCLUDED.category)`,
        [domain, category || null, sampleUrl || null, sampleQuery || null, now],
      );
    },

    async listDiscoveredSites(status) {
      const { rows } = status
        ? await pool.query(`SELECT * FROM discovered_sites WHERE status = $1 ORDER BY times_seen DESC`, [status])
        : await pool.query(`SELECT * FROM discovered_sites ORDER BY times_seen DESC`);
      return rows.map(rowToDiscoveredSite);
    },

    async setDiscoveredSiteStatus(id, status) {
      await pool.query(`UPDATE discovered_sites SET status = $1 WHERE id = $2`, [status, id]);
    },

    async addRemovedProduct({ kaprukaUrl, name, category, partnerName, reason, removedBy, sourcePage, snapshot }) {
      const { rows } = await pool.query(
        `INSERT INTO removed_products (created_at, kapruka_url, name, category, partner_name, reason, removed_by, source_page, snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT (kapruka_url) DO UPDATE SET
           created_at = EXCLUDED.created_at, name = EXCLUDED.name, category = EXCLUDED.category,
           partner_name = EXCLUDED.partner_name, reason = EXCLUDED.reason, removed_by = EXCLUDED.removed_by,
           source_page = EXCLUDED.source_page, snapshot = EXCLUDED.snapshot
         RETURNING *`,
        [nowIso(), kaprukaUrl, name || null, category || null, partnerName || null, reason, removedBy || null, sourcePage || null, JSON.stringify(snapshot || {})],
      );
      return rowToRemoved(rows[0]);
    },

    async deleteRemovedProduct(id) {
      await pool.query(`DELETE FROM removed_products WHERE id = $1`, [id]);
    },

    async upsertCompetitorProducts(siteDomain, products, category = null) {
      // Dedupe by product_url first — a multi-row INSERT ... ON CONFLICT DO
      // UPDATE errors if the same (site_domain, product_url) pair appears
      // twice in one statement, which happens when a product is listed on
      // more than one category page.
      const deduped = [...new Map(products.map((p) => [p.url, p])).values()];
      const CHUNK = 500;
      for (let i = 0; i < deduped.length; i += CHUNK) {
        const chunk = deduped.slice(i, i + CHUNK);
        const values = [];
        const params = [];
        chunk.forEach((p, idx) => {
          const base = idx * 7;
          values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
          params.push(siteDomain, p.siteName || null, p.url, p.name || null, p.priceLKR ?? null, nowIso(), category);
        });
        await pool.query(
          `INSERT INTO competitor_products (site_domain, site_name, product_url, product_name, price_lkr, scraped_at, category)
           VALUES ${values.join(',')}
           ON CONFLICT (site_domain, product_url) DO UPDATE SET
             site_name = EXCLUDED.site_name, product_name = EXCLUDED.product_name,
             price_lkr = EXCLUDED.price_lkr, scraped_at = EXCLUDED.scraped_at, category = EXCLUDED.category`,
          params,
        );
      }
    },

    async getCompetitorProducts(siteDomain) {
      const { rows } = await pool.query(
        `SELECT site_domain, site_name, product_url, product_name, price_lkr, scraped_at
         FROM competitor_products WHERE site_domain = $1`,
        [siteDomain],
      );
      return rows;
    },

    async searchCompetitorProductsByTokens(tokens, limit = 500) {
      if (!tokens.length) return [];
      const conds = tokens.map((_, i) => `product_name ILIKE $${i + 1}`).join(' AND ');
      const params = tokens.map((t) => `%${t}%`);
      const { rows } = await pool.query(
        `SELECT site_domain, site_name, product_url, product_name, price_lkr
         FROM competitor_products WHERE ${conds} LIMIT $${tokens.length + 1}`,
        [...params, limit],
      );
      return rows;
    },

    async upsertPriceAuditItem(item) {
      await pool.query(
        `INSERT INTO price_audit_items
           (category, kapruka_url, kapruka_name, kapruka_price_lkr, site_domain, site_name,
            matched_url, matched_name, matched_price_lkr, match_confidence, shared_codes,
            name_similarity, diff_lkr, diff_pct, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (kapruka_url, site_domain) DO UPDATE SET
           category = EXCLUDED.category, kapruka_name = EXCLUDED.kapruka_name,
           kapruka_price_lkr = EXCLUDED.kapruka_price_lkr, site_name = EXCLUDED.site_name,
           matched_url = EXCLUDED.matched_url, matched_name = EXCLUDED.matched_name,
           matched_price_lkr = EXCLUDED.matched_price_lkr, match_confidence = EXCLUDED.match_confidence,
           shared_codes = EXCLUDED.shared_codes, name_similarity = EXCLUDED.name_similarity,
           diff_lkr = EXCLUDED.diff_lkr, diff_pct = EXCLUDED.diff_pct, checked_at = EXCLUDED.checked_at`,
        [
          item.category, item.kaprukaUrl, item.kaprukaName || null, item.kaprukaPriceLkr ?? null,
          item.siteDomain, item.siteName || null, item.matchedUrl || null, item.matchedName || null,
          item.matchedPriceLkr ?? null, item.matchConfidence || null, item.sharedCodes ?? null,
          item.nameSimilarity ?? null, item.diffLkr ?? null, item.diffPct ?? null, nowIso(),
        ],
      );
    },

    async getPriceAuditItems({ category, limit = 500 } = {}) {
      const where = category ? 'WHERE category = $2' : '';
      const params = category ? [limit, category] : [limit];
      const { rows } = await pool.query(
        `SELECT * FROM price_audit_items ${where} ORDER BY checked_at DESC LIMIT $1`,
        params,
      );
      return rows;
    },

    // upsertPriceAuditItem only adds/updates — a product that matched last
    // run but no longer qualifies under stricter criteria (or a site that's
    // stopped carrying it) is never removed on its own, leaving stale rows
    // behind. Each match-local.js run calls this first so every run reports
    // exactly what it found, not a running union with past runs.
    async deletePriceAuditItemsByCategory(category) {
      await pool.query(`DELETE FROM price_audit_items WHERE category = $1`, [category]);
    },

    async listUnsupportedPartners() {
      const { rows } = await pool.query(
        `SELECT id, created_at, name, kapruka_url, partner_site, reason, detail
         FROM unsupported_partners ORDER BY id DESC`,
      );
      return rows;
    },

    async addUnsupportedPartner({ name, kaprukaUrl, partnerSite, reason, detail }) {
      await pool.query(
        `INSERT INTO unsupported_partners (created_at, name, kapruka_url, partner_site, reason, detail)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [nowIso(), name || null, kaprukaUrl || null, partnerSite, reason || null, detail || null],
      );
    },

    async countBulkRefreshesSince(sinceIso) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM bulk_refresh_log WHERE requested_at >= $1`,
        [sinceIso],
      );
      return rows[0].n;
    },

    async logBulkRefreshRequest() {
      await pool.query(`INSERT INTO bulk_refresh_log (requested_at) VALUES ($1)`, [nowIso()]);
    },

    async listPartnerRows() {
      const { rows } = await pool.query(
        `SELECT id, name, kapruka_url, kapruka_slug, partner_site, partner_label, platform, via_browser, refresh_requested_at
         FROM partners ORDER BY created_at ASC`,
      );
      return rows.map(rowToPartner);
    },

    async getPartnerRow(id) {
      const { rows } = await pool.query(
        `SELECT id, name, kapruka_url, kapruka_slug, partner_site, partner_label, platform, via_browser, refresh_requested_at
         FROM partners WHERE id = $1`,
        [id],
      );
      return rows[0] ? rowToPartner(rows[0]) : null;
    },

    async insertPartnerRow(p) {
      await pool.query(
        `INSERT INTO partners
           (id, name, kapruka_url, kapruka_slug, partner_site, partner_label, platform, via_browser, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [p.id, p.name, p.kaprukaUrl || null, p.kaprukaSlug || null, p.partnerSite,
          p.partnerLabel || null, p.platform || null, !!p.viaBrowser, nowIso()],
      );
      return p;
    },

    async requestPartnerRefresh(id) {
      await pool.query(`UPDATE partners SET refresh_requested_at = $1 WHERE id = $2`, [nowIso(), id]);
    },

    async getIntlGiftPairings(country) {
      const { rows } = await pool.query(
        `SELECT kapruka_sku, fnp_url, match_source, match_confidence
         FROM intl_gift_pairings WHERE country = $1`,
        [country],
      );
      const out = {};
      for (const r of rows) {
        out[r.kapruka_sku] = { fnpUrl: r.fnp_url, matchSource: r.match_source, matchConfidence: r.match_confidence };
      }
      return out;
    },

    async setIntlGiftPairing(country, sku, fnpUrl, matchSource, matchConfidence) {
      if (!fnpUrl) {
        await pool.query(`DELETE FROM intl_gift_pairings WHERE country = $1 AND kapruka_sku = $2`, [country, sku]);
        return;
      }
      await pool.query(
        `INSERT INTO intl_gift_pairings (country, kapruka_sku, fnp_url, match_source, match_confidence, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (country, kapruka_sku) DO UPDATE SET
           fnp_url = EXCLUDED.fnp_url, match_source = EXCLUDED.match_source,
           match_confidence = EXCLUDED.match_confidence, updated_at = EXCLUDED.updated_at`,
        [country, sku, fnpUrl, matchSource || null, matchConfidence || null, nowIso()],
      );
    },

    async getIntlGiftSnapshot(country) {
      const { rows } = await pool.query(
        `SELECT payload FROM intl_gift_snapshots WHERE country = $1`,
        [country],
      );
      return rows[0] ? rows[0].payload : null;
    },

    async setIntlGiftSnapshot(country, payload) {
      await pool.query(
        `INSERT INTO intl_gift_snapshots (country, generated_at, payload)
         VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (country) DO UPDATE SET generated_at = EXCLUDED.generated_at, payload = EXCLUDED.payload`,
        [country, nowIso(), JSON.stringify(payload)],
      );
    },

    async savePriceCheck({ category, query, result }) {
      const { rows } = await pool.query(
        `INSERT INTO price_checks
           (created_at, category, query_name, description, result_count, discovered_count, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
        [
          nowIso(),
          category,
          query?.name ?? null,
          query?.description ?? null,
          (result.results || []).length,
          (result.discovered || []).length,
          JSON.stringify(result),
        ],
      );
      return Number(rows[0].id);
    },

    async saveComparisonRun(data) {
      const s = data.summary;
      const { rows } = await pool.query(
        `INSERT INTO comparison_runs
           (created_at, partner_id, partner_name, kapruka_slug, partner_site, platform,
            kapruka_count, partner_count, matched, kapruka_higher, kapruka_lower,
            same_price, only_kapruka, only_partner, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) RETURNING id`,
        [
          data.generatedAt || nowIso(),
          data.partner.id,
          data.partner.name,
          data.partner.kaprukaSlug,
          data.partner.partnerSite,
          data.partner.platform,
          data.catalogCounts.kapruka,
          data.catalogCounts.partner,
          s.matched,
          s.kaprukaHigher,
          s.kaprukaLower,
          s.same,
          s.onlyKapruka,
          s.onlyPartner,
          JSON.stringify(data),
        ],
      );
      return Number(rows[0].id);
    },

    async recentPriceChecks(limit = 50) {
      const { rows } = await pool.query(
        `SELECT id, created_at, category, query_name, description, result_count, discovered_count
         FROM price_checks ORDER BY id DESC LIMIT $1`,
        [limit],
      );
      return rows;
    },

    async recentComparisonRuns(limit = 50, partnerId = null) {
      const where = partnerId ? 'WHERE partner_id = $2' : '';
      const params = partnerId ? [limit, partnerId] : [limit];
      const { rows } = await pool.query(
        `SELECT id, created_at, partner_id, partner_name, platform, kapruka_count, partner_count,
                matched, kapruka_higher, kapruka_lower, same_price, only_kapruka, only_partner
         FROM comparison_runs ${where} ORDER BY id DESC LIMIT $1`,
        params,
      );
      return rows;
    },

    async getComparisonRun(id) {
      const { rows } = await pool.query(
        `SELECT payload::text AS payload_json FROM comparison_runs WHERE id = $1`,
        [id],
      );
      return rows[0] ? JSON.parse(rows[0].payload_json) : null;
    },

    async allPriceCheckRows() {
      const { rows } = await pool.query(
        `SELECT id, created_at, payload::text AS payload_json FROM price_checks ORDER BY id`,
      );
      return rows;
    },

    async allComparisonRows(partnerId = null) {
      const where = partnerId ? 'WHERE partner_id = $1' : '';
      const params = partnerId ? [partnerId] : [];
      const { rows } = await pool.query(
        `SELECT id, created_at, payload::text AS payload_json FROM comparison_runs ${where} ORDER BY id`,
        params,
      );
      return rows;
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase REST backend (PostgREST over HTTPS — no direct DB port needed)
// ---------------------------------------------------------------------------
//
// Run this once in the Supabase SQL Editor before using this backend — REST
// can insert/query rows but can't create tables:
//
//   CREATE TABLE IF NOT EXISTS price_checks (
//     id               BIGSERIAL PRIMARY KEY,
//     created_at       TEXT NOT NULL,
//     category         TEXT,
//     query_name       TEXT,
//     description      TEXT,
//     result_count     INTEGER,
//     discovered_count INTEGER,
//     payload          JSONB NOT NULL
//   );
//   CREATE TABLE IF NOT EXISTS comparison_runs (
//     id             BIGSERIAL PRIMARY KEY,
//     created_at     TEXT NOT NULL,
//     partner_id     TEXT,
//     partner_name   TEXT,
//     kapruka_slug   TEXT,
//     partner_site   TEXT,
//     platform       TEXT,
//     kapruka_count  INTEGER,
//     partner_count  INTEGER,
//     matched        INTEGER,
//     kapruka_higher INTEGER,
//     kapruka_lower  INTEGER,
//     same_price     INTEGER,
//     only_kapruka   INTEGER,
//     only_partner   INTEGER,
//     payload        JSONB NOT NULL
//   );
//   CREATE INDEX IF NOT EXISTS idx_runs_partner ON comparison_runs (partner_id, created_at);
//   CREATE INDEX IF NOT EXISTS idx_checks_name ON price_checks (query_name, created_at);
//   CREATE TABLE IF NOT EXISTS partners (
//     id            TEXT PRIMARY KEY,
//     name          TEXT NOT NULL,
//     kapruka_url   TEXT,
//     kapruka_slug  TEXT,
//     partner_site  TEXT NOT NULL,
//     partner_label TEXT,
//     platform      TEXT,
//     via_browser   BOOLEAN DEFAULT false,
//     created_at    TEXT NOT NULL,
//     refresh_requested_at TEXT
//   );
//   CREATE TABLE IF NOT EXISTS intl_gift_pairings (
//     id                BIGSERIAL PRIMARY KEY,
//     country           TEXT NOT NULL,
//     kapruka_sku       TEXT NOT NULL,
//     fnp_url           TEXT NOT NULL,
//     match_source      TEXT,
//     match_confidence  TEXT,
//     updated_at        TEXT NOT NULL,
//     UNIQUE (country, kapruka_sku)
//   );
//   CREATE TABLE IF NOT EXISTS intl_gift_snapshots (
//     id             BIGSERIAL PRIMARY KEY,
//     country        TEXT NOT NULL UNIQUE,
//     generated_at   TEXT NOT NULL,
//     payload        JSONB NOT NULL
//   );
//   CREATE TABLE IF NOT EXISTS unsupported_partners (
//     id            BIGSERIAL PRIMARY KEY,
//     created_at    TEXT NOT NULL,
//     name          TEXT,
//     kapruka_url   TEXT,
//     partner_site  TEXT NOT NULL,
//     reason        TEXT,
//     detail        TEXT
//   );
//   CREATE TABLE IF NOT EXISTS bulk_refresh_log (
//     id            BIGSERIAL PRIMARY KEY,
//     requested_at  TEXT NOT NULL
//   );
//   CREATE TABLE IF NOT EXISTS price_audit_items (
//     id                 BIGSERIAL PRIMARY KEY,
//     category           TEXT NOT NULL,
//     kapruka_url        TEXT NOT NULL,
//     kapruka_name       TEXT,
//     kapruka_price_lkr  INTEGER,
//     site_domain        TEXT NOT NULL,
//     site_name          TEXT,
//     matched_url        TEXT,
//     matched_name       TEXT,
//     matched_price_lkr  INTEGER,
//     match_confidence   TEXT,
//     shared_codes       INTEGER,
//     name_similarity    INTEGER,
//     diff_lkr           INTEGER,
//     diff_pct           NUMERIC,
//     checked_at         TEXT NOT NULL,
//     UNIQUE (kapruka_url, site_domain)
//   );
//   CREATE INDEX IF NOT EXISTS idx_audit_category ON price_audit_items (category, checked_at);
//   CREATE INDEX IF NOT EXISTS idx_audit_kapruka_url ON price_audit_items (kapruka_url);
//   CREATE TABLE IF NOT EXISTS competitor_products (
//     id            BIGSERIAL PRIMARY KEY,
//     site_domain   TEXT NOT NULL,
//     site_name     TEXT,
//     product_url   TEXT NOT NULL,
//     product_name  TEXT,
//     price_lkr     INTEGER,
//     scraped_at    TEXT NOT NULL,
//     UNIQUE (site_domain, product_url)
//   );
//   CREATE INDEX IF NOT EXISTS idx_competitor_products_site ON competitor_products (site_domain);
//   CREATE TABLE IF NOT EXISTS removed_products (
//     id            BIGSERIAL PRIMARY KEY,
//     created_at    TEXT NOT NULL,
//     kapruka_url   TEXT NOT NULL UNIQUE,
//     name          TEXT,
//     category      TEXT,
//     partner_name  TEXT,
//     reason        TEXT NOT NULL,
//     removed_by    TEXT,
//     source_page   TEXT,
//     snapshot      JSONB
//   );
//   -- Already had a removed_products table before removed_by existed? Run:
//   -- ALTER TABLE removed_products ADD COLUMN IF NOT EXISTS removed_by TEXT;
//   CREATE TABLE IF NOT EXISTS discovered_sites (
//     id            BIGSERIAL PRIMARY KEY,
//     domain        TEXT NOT NULL UNIQUE,
//     category      TEXT,
//     sample_url    TEXT,
//     sample_query  TEXT,
//     times_seen    INTEGER NOT NULL DEFAULT 1,
//     first_seen    TEXT NOT NULL,
//     last_seen     TEXT NOT NULL,
//     status        TEXT NOT NULL DEFAULT 'pending'
//   );
//   -- The static dashboard (GitHub Pages) reads this table directly with a
//   -- public anon key, so it needs RLS enabled with a public SELECT policy:
//   ALTER TABLE intl_gift_snapshots ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "Public read" ON intl_gift_snapshots FOR SELECT USING (true);

async function makeSupabaseRestBackend(baseUrl, serviceKey) {
  const REST = `${baseUrl.replace(/\/$/, '')}/rest/v1`;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  async function restFetch(path, opts = {}) {
    const res = await fetch(`${REST}${path}`, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Supabase REST ${res.status} on ${path}: ${text}`);
    }
    // PostgREST returns an empty body (not just on 204) whenever the request
    // didn't ask for `Prefer: return=representation` — e.g. a plain upsert.
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Fetch every row from a table in id-ascending order, in bounded batches
  // instead of one unpaginated request. A single `?select=...&order=id.asc`
  // with no limit asks PostgREST to sort and stream the WHOLE table
  // (including a JSONB payload column that can be large) in one query — fine
  // when the table is small, but as comparison_runs/price_checks grow this
  // starts blowing past Supabase's statement_timeout ("57014: canceling
  // statement due to statement timeout"), breaking CSV export AND every
  // dashboard that calls latestRunPerPartner() (overpriced, stock-mismatch).
  // Keyset pagination (id > cursor, indexed via the primary key) keeps each
  // request small and fast regardless of total table size.
  // Individual payload rows here run tens to hundreds of KB (a comparison run
  // serializes a partner's whole catalogue match) — 500/batch measured at
  // ~45MB and 7-13s, right at the edge of Supabase's statement_timeout under
  // load. 100/batch measured ~11MB in under 2s, with comfortable margin.
  const PAGE_SIZE = 100;
  async function restFetchPaged(basePath, extraFilter = '') {
    const rows = [];
    let cursor = 0;
    for (;;) {
      const page = await restFetch(
        `${basePath}&id=gt.${cursor}${extraFilter}&order=id.asc&limit=${PAGE_SIZE}`,
      );
      if (!page.length) break;
      rows.push(...page);
      cursor = page[page.length - 1].id;
      if (page.length < PAGE_SIZE) break;
    }
    return rows;
  }

  async function insert(table, row) {
    const rows = await restFetch(`/${table}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    return Number(rows[0].id);
  }

  return {
    async listRemovedProducts() {
      const rows = await restFetch('/removed_products?select=*&order=created_at.desc');
      return rows.map(rowToRemoved);
    },

    async addRemovedProduct({ kaprukaUrl, name, category, partnerName, reason, removedBy, sourcePage, snapshot }) {
      const rows = await restFetch('/removed_products?on_conflict=kapruka_url', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          created_at: nowIso(),
          kapruka_url: kaprukaUrl,
          name: name || null,
          category: category || null,
          partner_name: partnerName || null,
          reason,
          removed_by: removedBy || null,
          source_page: sourcePage || null,
          snapshot: snapshot || {},
        }),
      });
      return rowToRemoved(rows[0]);
    },

    async deleteRemovedProduct(id) {
      await restFetch(`/removed_products?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    // PostgREST has no server-side "increment on conflict" for a plain
    // upsert (no arbitrary SQL expressions in the request body), so this is
    // read-then-write: low-stakes, low-frequency (one call per newly-
    // discovered domain per search), so the tiny race window on a
    // simultaneous first-sighting from two concurrent searches isn't worth
    // the complexity of a real atomic increment.
    async upsertDiscoveredSite({ domain, category, sampleUrl, sampleQuery }) {
      const now = nowIso();
      const existing = await restFetch(`/discovered_sites?select=id,times_seen,category&domain=eq.${encodeURIComponent(domain)}&limit=1`);
      if (existing.length) {
        await restFetch(`/discovered_sites?id=eq.${existing[0].id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            times_seen: existing[0].times_seen + 1,
            last_seen: now,
            category: existing[0].category || category || null,
          }),
        });
      } else {
        await restFetch('/discovered_sites', {
          method: 'POST',
          body: JSON.stringify({
            domain, category: category || null, sample_url: sampleUrl || null, sample_query: sampleQuery || null,
            times_seen: 1, first_seen: now, last_seen: now, status: 'pending',
          }),
        });
      }
    },

    async listDiscoveredSites(status) {
      const filter = status ? `&status=eq.${encodeURIComponent(status)}` : '';
      const rows = await restFetch(`/discovered_sites?select=*&order=times_seen.desc${filter}`);
      return rows.map(rowToDiscoveredSite);
    },

    async setDiscoveredSiteStatus(id, status) {
      await restFetch(`/discovered_sites?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
    },

    async upsertCompetitorProducts(siteDomain, products, category = null) {
      // Dedupe by product_url first — Postgres's ON CONFLICT DO UPDATE errors
      // out ("command cannot affect row a second time") if the same
      // (site_domain, product_url) pair appears twice in one upsert batch,
      // which happens when a product is listed on more than one category page.
      const deduped = [...new Map(products.map((p) => [p.url, p])).values()];
      const CHUNK = 500;
      for (let i = 0; i < deduped.length; i += CHUNK) {
        const chunk = deduped.slice(i, i + CHUNK).map((p) => ({
          site_domain: siteDomain,
          site_name: p.siteName || null,
          product_url: p.url,
          product_name: p.name || null,
          price_lkr: p.priceLKR ?? null,
          scraped_at: nowIso(),
          category,
        }));
        await restFetch('/competitor_products?on_conflict=site_domain,product_url', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(chunk),
        });
      }
    },

    async getCompetitorProducts(siteDomain) {
      // PostgREST caps unbounded selects at the project's default row limit
      // (commonly 1000) — silently, with no error, so a naive single fetch
      // truncates any site with a larger catalogue. Page with limit/offset
      // until a page comes back short.
      const PAGE = 1000;
      const out = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await restFetch(
          `/competitor_products?select=site_domain,site_name,product_url,product_name,price_lkr,scraped_at` +
            `&site_domain=eq.${encodeURIComponent(siteDomain)}&limit=${PAGE}&offset=${offset}`,
        );
        out.push(...page);
        if (page.length < PAGE) break;
      }
      return out;
    },

    async searchCompetitorProductsByTokens(tokens, limit = 500) {
      if (!tokens.length) return [];
      // PostgREST ANDs repeated filters on the same column (each ?product_name=
      // ilike.*token* occurrence is a separate clause) — no wildcard escaping
      // needed since the tokens come from tokenize(), which is already
      // alnum-only.
      const filters = tokens.map((t) => `product_name=ilike.*${encodeURIComponent(t)}*`).join('&');
      return restFetch(
        `/competitor_products?select=site_domain,site_name,product_url,product_name,price_lkr&${filters}&limit=${limit}`,
      );
    },

    async upsertPriceAuditItem(item) {
      await restFetch('/price_audit_items?on_conflict=kapruka_url,site_domain', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          category: item.category,
          kapruka_url: item.kaprukaUrl,
          kapruka_name: item.kaprukaName || null,
          kapruka_price_lkr: item.kaprukaPriceLkr ?? null,
          site_domain: item.siteDomain,
          site_name: item.siteName || null,
          matched_url: item.matchedUrl || null,
          matched_name: item.matchedName || null,
          matched_price_lkr: item.matchedPriceLkr ?? null,
          match_confidence: item.matchConfidence || null,
          shared_codes: item.sharedCodes ?? null,
          name_similarity: item.nameSimilarity ?? null,
          diff_lkr: item.diffLkr ?? null,
          diff_pct: item.diffPct ?? null,
          checked_at: nowIso(),
        }),
      });
    },

    async getPriceAuditItems({ category, limit = 500 } = {}) {
      // PostgREST caps any single response at the project's default row limit
      // (commonly 1000) regardless of a higher `limit` query param — silently,
      // with no error. Page in <=1000-row chunks until `limit` is reached or
      // a short page signals the end.
      const filter = category ? `&category=eq.${encodeURIComponent(category)}` : '';
      const PAGE = 1000;
      const out = [];
      for (let offset = 0; offset < limit; offset += PAGE) {
        const pageSize = Math.min(PAGE, limit - offset);
        const page = await restFetch(
          `/price_audit_items?select=*&order=checked_at.desc&limit=${pageSize}&offset=${offset}${filter}`,
        );
        out.push(...page);
        if (page.length < pageSize) break;
      }
      return out;
    },

    // upsertPriceAuditItem only adds/updates — a product that matched last
    // run but no longer qualifies under stricter criteria (or a site that's
    // stopped carrying it) is never removed on its own, leaving stale rows
    // behind. Each match-local.js run calls this first so every run reports
    // exactly what it found, not a running union with past runs.
    async deletePriceAuditItemsByCategory(category) {
      await restFetch(`/price_audit_items?category=eq.${encodeURIComponent(category)}`, { method: 'DELETE' });
    },

    async listUnsupportedPartners() {
      return restFetch('/unsupported_partners?select=id,created_at,name,kapruka_url,partner_site,reason,detail&order=id.desc');
    },

    async addUnsupportedPartner({ name, kaprukaUrl, partnerSite, reason, detail }) {
      await restFetch('/unsupported_partners', {
        method: 'POST',
        body: JSON.stringify({
          created_at: nowIso(),
          name: name || null,
          kapruka_url: kaprukaUrl || null,
          partner_site: partnerSite,
          reason: reason || null,
          detail: detail || null,
        }),
      });
    },

    async countBulkRefreshesSince(sinceIso) {
      const rows = await restFetch(`/bulk_refresh_log?select=id&requested_at=gte.${encodeURIComponent(sinceIso)}`);
      return rows.length;
    },

    async logBulkRefreshRequest() {
      await restFetch('/bulk_refresh_log', {
        method: 'POST',
        body: JSON.stringify({ requested_at: nowIso() }),
      });
    },

    async listPartnerRows() {
      const rows = await restFetch(
        '/partners?select=id,name,kapruka_url,kapruka_slug,partner_site,partner_label,platform,via_browser,refresh_requested_at' +
          '&order=created_at.asc',
      );
      return rows.map(rowToPartner);
    },

    async getPartnerRow(id) {
      const rows = await restFetch(
        '/partners?select=id,name,kapruka_url,kapruka_slug,partner_site,partner_label,platform,via_browser,refresh_requested_at' +
          `&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      return rows[0] ? rowToPartner(rows[0]) : null;
    },

    async insertPartnerRow(p) {
      await restFetch('/partners', {
        method: 'POST',
        body: JSON.stringify({
          id: p.id,
          name: p.name,
          kapruka_url: p.kaprukaUrl || null,
          kapruka_slug: p.kaprukaSlug || null,
          partner_site: p.partnerSite,
          partner_label: p.partnerLabel || null,
          platform: p.platform || null,
          via_browser: !!p.viaBrowser,
          created_at: nowIso(),
        }),
      });
      return p;
    },

    async requestPartnerRefresh(id) {
      await restFetch(`/partners?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ refresh_requested_at: nowIso() }),
      });
    },

    async getIntlGiftPairings(country) {
      const rows = await restFetch(
        `/intl_gift_pairings?select=kapruka_sku,fnp_url,match_source,match_confidence` +
          `&country=eq.${encodeURIComponent(country)}`,
      );
      const out = {};
      for (const r of rows) {
        out[r.kapruka_sku] = { fnpUrl: r.fnp_url, matchSource: r.match_source, matchConfidence: r.match_confidence };
      }
      return out;
    },

    async setIntlGiftPairing(country, sku, fnpUrl, matchSource, matchConfidence) {
      if (!fnpUrl) {
        await restFetch(
          `/intl_gift_pairings?country=eq.${encodeURIComponent(country)}&kapruka_sku=eq.${encodeURIComponent(sku)}`,
          { method: 'DELETE' },
        );
        return;
      }
      await restFetch(`/intl_gift_pairings?on_conflict=country,kapruka_sku`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          country,
          kapruka_sku: sku,
          fnp_url: fnpUrl,
          match_source: matchSource || null,
          match_confidence: matchConfidence || null,
          updated_at: nowIso(),
        }),
      });
    },

    async getIntlGiftSnapshot(country) {
      const rows = await restFetch(`/intl_gift_snapshots?select=payload&country=eq.${encodeURIComponent(country)}`);
      return rows[0] ? rows[0].payload : null;
    },

    async setIntlGiftSnapshot(country, payload) {
      await restFetch(`/intl_gift_snapshots?on_conflict=country`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ country, generated_at: nowIso(), payload }),
      });
    },

    async savePriceCheck({ category, query, result }) {
      return insert('price_checks', {
        created_at: nowIso(),
        category,
        query_name: query?.name ?? null,
        description: query?.description ?? null,
        result_count: (result.results || []).length,
        discovered_count: (result.discovered || []).length,
        payload: result,
      });
    },

    async saveComparisonRun(data) {
      const s = data.summary;
      return insert('comparison_runs', {
        created_at: data.generatedAt || nowIso(),
        partner_id: data.partner.id,
        partner_name: data.partner.name,
        kapruka_slug: data.partner.kaprukaSlug,
        partner_site: data.partner.partnerSite,
        platform: data.partner.platform,
        kapruka_count: data.catalogCounts.kapruka,
        partner_count: data.catalogCounts.partner,
        matched: s.matched,
        kapruka_higher: s.kaprukaHigher,
        kapruka_lower: s.kaprukaLower,
        same_price: s.same,
        only_kapruka: s.onlyKapruka,
        only_partner: s.onlyPartner,
        payload: data,
      });
    },

    async recentPriceChecks(limit = 50) {
      return restFetch(
        `/price_checks?select=id,created_at,category,query_name,description,result_count,discovered_count` +
          `&order=id.desc&limit=${limit}`,
      );
    },

    async recentComparisonRuns(limit = 50, partnerId = null) {
      const filter = partnerId ? `&partner_id=eq.${encodeURIComponent(partnerId)}` : '';
      return restFetch(
        `/comparison_runs?select=id,created_at,partner_id,partner_name,platform,kapruka_count,partner_count,` +
          `matched,kapruka_higher,kapruka_lower,same_price,only_kapruka,only_partner` +
          `&order=id.desc&limit=${limit}${filter}`,
      );
    },

    async getComparisonRun(id) {
      const rows = await restFetch(`/comparison_runs?select=payload&id=eq.${id}&limit=1`);
      return rows[0] ? rows[0].payload : null;
    },

    // allPriceCheckRows/allComparisonRows return payload_json as a STRING (not
    // a parsed object) to match the Postgres/SQLite backends' contract — every
    // caller in export.js does JSON.parse(row.payload_json) itself.
    async allPriceCheckRows() {
      const rows = await restFetchPaged(`/price_checks?select=id,created_at,payload`);
      return rows.map((r) => ({ id: r.id, created_at: r.created_at, payload_json: JSON.stringify(r.payload) }));
    },

    async allComparisonRows(partnerId = null) {
      const filter = partnerId ? `&partner_id=eq.${encodeURIComponent(partnerId)}` : '';
      const rows = await restFetchPaged(`/comparison_runs?select=id,created_at,payload`, filter);
      return rows.map((r) => ({ id: r.id, created_at: r.created_at, payload_json: JSON.stringify(r.payload) }));
    },
  };
}

// ---------------------------------------------------------------------------
// SQLite backend (local fallback)
// ---------------------------------------------------------------------------

async function makeSqliteBackend() {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
  mkdirSync(DATA_DIR, { recursive: true });

  const db = new DatabaseSync(join(DATA_DIR, 'price-tools.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_checks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL,
      category      TEXT,
      query_name    TEXT,
      description   TEXT,
      result_count  INTEGER,
      discovered_count INTEGER,
      payload_json  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comparison_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL,
      partner_id    TEXT,
      partner_name  TEXT,
      kapruka_slug  TEXT,
      partner_site  TEXT,
      platform      TEXT,
      kapruka_count INTEGER,
      partner_count INTEGER,
      matched       INTEGER,
      kapruka_higher INTEGER,
      kapruka_lower INTEGER,
      same_price    INTEGER,
      only_kapruka  INTEGER,
      only_partner  INTEGER,
      payload_json  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_partner ON comparison_runs (partner_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_checks_name ON price_checks (query_name, created_at);
    CREATE TABLE IF NOT EXISTS partners (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      kapruka_url           TEXT,
      kapruka_slug          TEXT,
      partner_site          TEXT NOT NULL,
      partner_label         TEXT,
      platform              TEXT,
      via_browser           INTEGER DEFAULT 0,
      created_at            TEXT NOT NULL,
      refresh_requested_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS intl_gift_pairings (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      country           TEXT NOT NULL,
      kapruka_sku       TEXT NOT NULL,
      fnp_url           TEXT NOT NULL,
      match_source      TEXT,
      match_confidence  TEXT,
      updated_at        TEXT NOT NULL,
      UNIQUE (country, kapruka_sku)
    );
    CREATE TABLE IF NOT EXISTS intl_gift_snapshots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      country        TEXT NOT NULL UNIQUE,
      generated_at   TEXT NOT NULL,
      payload_json   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS unsupported_partners (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL,
      name          TEXT,
      kapruka_url   TEXT,
      partner_site  TEXT NOT NULL,
      reason        TEXT,
      detail        TEXT
    );
    CREATE TABLE IF NOT EXISTS bulk_refresh_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_audit_items (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      category           TEXT NOT NULL,
      kapruka_url        TEXT NOT NULL,
      kapruka_name       TEXT,
      kapruka_price_lkr  INTEGER,
      site_domain        TEXT NOT NULL,
      site_name          TEXT,
      matched_url        TEXT,
      matched_name       TEXT,
      matched_price_lkr  INTEGER,
      match_confidence   TEXT,
      shared_codes       INTEGER,
      name_similarity    INTEGER,
      diff_lkr           INTEGER,
      diff_pct           REAL,
      checked_at         TEXT NOT NULL,
      UNIQUE (kapruka_url, site_domain)
    );
    CREATE INDEX IF NOT EXISTS idx_audit_category ON price_audit_items (category, checked_at);
    CREATE INDEX IF NOT EXISTS idx_audit_kapruka_url ON price_audit_items (kapruka_url);
    CREATE TABLE IF NOT EXISTS competitor_products (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      site_domain   TEXT NOT NULL,
      site_name     TEXT,
      product_url   TEXT NOT NULL,
      product_name  TEXT,
      price_lkr     INTEGER,
      scraped_at    TEXT NOT NULL,
      category      TEXT,
      UNIQUE (site_domain, product_url)
    );
    CREATE INDEX IF NOT EXISTS idx_competitor_products_site ON competitor_products (site_domain);
    CREATE TABLE IF NOT EXISTS removed_products (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL,
      kapruka_url   TEXT NOT NULL UNIQUE,
      name          TEXT,
      category      TEXT,
      partner_name  TEXT,
      reason        TEXT NOT NULL,
      removed_by    TEXT,
      source_page   TEXT,
      snapshot_json TEXT
    );
    CREATE TABLE IF NOT EXISTS discovered_sites (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      domain        TEXT NOT NULL UNIQUE,
      category      TEXT,
      sample_url    TEXT,
      sample_query  TEXT,
      times_seen    INTEGER NOT NULL DEFAULT 1,
      first_seen    TEXT NOT NULL,
      last_seen     TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending'
    );
  `);

  const rowToRemovedSqlite = (r) => ({
    id: r.id,
    createdAt: r.created_at,
    kaprukaUrl: r.kapruka_url,
    name: r.name || '',
    category: r.category || '',
    partnerName: r.partner_name || '',
    reason: r.reason || '',
    removedBy: r.removed_by || '',
    sourcePage: r.source_page || '',
    snapshot: r.snapshot_json ? JSON.parse(r.snapshot_json) : null,
  });
  const selRemoved = db.prepare(`SELECT * FROM removed_products ORDER BY created_at DESC`);
  const selRemovedByUrl = db.prepare(`SELECT * FROM removed_products WHERE kapruka_url = ?`);
  const upsertRemoved = db.prepare(`
    INSERT INTO removed_products (created_at, kapruka_url, name, category, partner_name, reason, removed_by, source_page, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (kapruka_url) DO UPDATE SET
      created_at = excluded.created_at, name = excluded.name, category = excluded.category,
      partner_name = excluded.partner_name, reason = excluded.reason, removed_by = excluded.removed_by,
      source_page = excluded.source_page, snapshot_json = excluded.snapshot_json`);
  const delRemoved = db.prepare(`DELETE FROM removed_products WHERE id = ?`);

  const selDiscoveredByDomain = db.prepare(`SELECT * FROM discovered_sites WHERE domain = ?`);
  const selDiscoveredAll = db.prepare(`SELECT * FROM discovered_sites ORDER BY times_seen DESC`);
  const selDiscoveredByStatus = db.prepare(`SELECT * FROM discovered_sites WHERE status = ? ORDER BY times_seen DESC`);
  const insDiscovered = db.prepare(`
    INSERT INTO discovered_sites (domain, category, sample_url, sample_query, times_seen, first_seen, last_seen, status)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'pending')`);
  const updDiscoveredSeen = db.prepare(`
    UPDATE discovered_sites SET times_seen = times_seen + 1, last_seen = ?, category = COALESCE(category, ?) WHERE domain = ?`);
  const updDiscoveredStatus = db.prepare(`UPDATE discovered_sites SET status = ? WHERE id = ?`);

  const upsertCompetitorProduct = db.prepare(`
    INSERT INTO competitor_products (site_domain, site_name, product_url, product_name, price_lkr, scraped_at, category)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (site_domain, product_url) DO UPDATE SET
      site_name = excluded.site_name, product_name = excluded.product_name,
      price_lkr = excluded.price_lkr, scraped_at = excluded.scraped_at, category = excluded.category`);
  const selCompetitorProducts = db.prepare(`
    SELECT site_domain, site_name, product_url, product_name, price_lkr, scraped_at, category
    FROM competitor_products WHERE site_domain = ?`);

  const insChk = db.prepare(`
    INSERT INTO price_checks (created_at, category, query_name, description, result_count, discovered_count, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insRun = db.prepare(`
    INSERT INTO comparison_runs
      (created_at, partner_id, partner_name, kapruka_slug, partner_site, platform,
       kapruka_count, partner_count, matched, kapruka_higher, kapruka_lower,
       same_price, only_kapruka, only_partner, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const selPartners = db.prepare(`
    SELECT id, name, kapruka_url, kapruka_slug, partner_site, partner_label, platform, via_browser, refresh_requested_at
    FROM partners ORDER BY created_at ASC`);
  const selPartner = db.prepare(`
    SELECT id, name, kapruka_url, kapruka_slug, partner_site, partner_label, platform, via_browser, refresh_requested_at
    FROM partners WHERE id = ?`);
  const insPartner = db.prepare(`
    INSERT INTO partners
      (id, name, kapruka_url, kapruka_slug, partner_site, partner_label, platform, via_browser, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updPartnerRefreshRequest = db.prepare(`UPDATE partners SET refresh_requested_at = ? WHERE id = ?`);
  const selPairings = db.prepare(
    `SELECT kapruka_sku, fnp_url, match_source, match_confidence FROM intl_gift_pairings WHERE country = ?`,
  );
  const delPairing = db.prepare(`DELETE FROM intl_gift_pairings WHERE country = ? AND kapruka_sku = ?`);
  const upsertPairing = db.prepare(`
    INSERT INTO intl_gift_pairings (country, kapruka_sku, fnp_url, match_source, match_confidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (country, kapruka_sku) DO UPDATE SET
      fnp_url = excluded.fnp_url, match_source = excluded.match_source,
      match_confidence = excluded.match_confidence, updated_at = excluded.updated_at`);
  const selSnapshot = db.prepare(`SELECT payload_json FROM intl_gift_snapshots WHERE country = ?`);
  const upsertSnapshot = db.prepare(`
    INSERT INTO intl_gift_snapshots (country, generated_at, payload_json)
    VALUES (?, ?, ?)
    ON CONFLICT (country) DO UPDATE SET generated_at = excluded.generated_at, payload_json = excluded.payload_json`);
  const selUnsupported = db.prepare(`
    SELECT id, created_at, name, kapruka_url, partner_site, reason, detail
    FROM unsupported_partners ORDER BY id DESC`);
  const insUnsupported = db.prepare(`
    INSERT INTO unsupported_partners (created_at, name, kapruka_url, partner_site, reason, detail)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const selBulkRefreshCount = db.prepare(`SELECT COUNT(*) AS n FROM bulk_refresh_log WHERE requested_at >= ?`);
  const insBulkRefresh = db.prepare(`INSERT INTO bulk_refresh_log (requested_at) VALUES (?)`);
  const upsertAuditItem = db.prepare(`
    INSERT INTO price_audit_items
      (category, kapruka_url, kapruka_name, kapruka_price_lkr, site_domain, site_name,
       matched_url, matched_name, matched_price_lkr, match_confidence, shared_codes,
       name_similarity, diff_lkr, diff_pct, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (kapruka_url, site_domain) DO UPDATE SET
      category = excluded.category, kapruka_name = excluded.kapruka_name,
      kapruka_price_lkr = excluded.kapruka_price_lkr, site_name = excluded.site_name,
      matched_url = excluded.matched_url, matched_name = excluded.matched_name,
      matched_price_lkr = excluded.matched_price_lkr, match_confidence = excluded.match_confidence,
      shared_codes = excluded.shared_codes, name_similarity = excluded.name_similarity,
      diff_lkr = excluded.diff_lkr, diff_pct = excluded.diff_pct, checked_at = excluded.checked_at`);

  return {
    async listRemovedProducts() {
      return selRemoved.all().map(rowToRemovedSqlite);
    },

    async addRemovedProduct({ kaprukaUrl, name, category, partnerName, reason, removedBy, sourcePage, snapshot }) {
      upsertRemoved.run(
        nowIso(), kaprukaUrl, name || null, category || null, partnerName || null,
        reason, removedBy || null, sourcePage || null, JSON.stringify(snapshot || {}),
      );
      return rowToRemovedSqlite(selRemovedByUrl.get(kaprukaUrl));
    },

    async deleteRemovedProduct(id) {
      delRemoved.run(id);
    },

    async upsertDiscoveredSite({ domain, category, sampleUrl, sampleQuery }) {
      const now = nowIso();
      const existing = selDiscoveredByDomain.get(domain);
      if (existing) {
        updDiscoveredSeen.run(now, category || null, domain);
      } else {
        insDiscovered.run(domain, category || null, sampleUrl || null, sampleQuery || null, now, now);
      }
    },

    async listDiscoveredSites(status) {
      return (status ? selDiscoveredByStatus.all(status) : selDiscoveredAll.all()).map(rowToDiscoveredSite);
    },

    async setDiscoveredSiteStatus(id, status) {
      updDiscoveredStatus.run(status, id);
    },

    async upsertCompetitorProducts(siteDomain, products, category = null) {
      // node:sqlite's DatabaseSync has no .transaction() helper (that's a
      // better-sqlite3-only convenience method) — wrap with raw BEGIN/COMMIT
      // instead, which DatabaseSync does support via .exec().
      const ts = nowIso();
      db.exec('BEGIN');
      try {
        for (const p of products) {
          upsertCompetitorProduct.run(siteDomain, p.siteName || null, p.url, p.name || null, p.priceLKR ?? null, ts, category);
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },

    async getCompetitorProducts(siteDomain) {
      return selCompetitorProducts.all(siteDomain);
    },

    async searchCompetitorProductsByTokens(tokens, limit = 500) {
      if (!tokens.length) return [];
      const conds = tokens.map(() => 'product_name LIKE ?').join(' AND ');
      const params = tokens.map((t) => `%${t}%`);
      return db
        .prepare(
          `SELECT site_domain, site_name, product_url, product_name, price_lkr
           FROM competitor_products WHERE ${conds} LIMIT ?`,
        )
        .all(...params, limit);
    },

    async upsertPriceAuditItem(item) {
      upsertAuditItem.run(
        item.category, item.kaprukaUrl, item.kaprukaName || null, item.kaprukaPriceLkr ?? null,
        item.siteDomain, item.siteName || null, item.matchedUrl || null, item.matchedName || null,
        item.matchedPriceLkr ?? null, item.matchConfidence || null, item.sharedCodes ?? null,
        item.nameSimilarity ?? null, item.diffLkr ?? null, item.diffPct ?? null, nowIso(),
      );
    },

    async getPriceAuditItems({ category, limit = 500 } = {}) {
      const sql = `SELECT * FROM price_audit_items ${category ? 'WHERE category = ?' : ''}
                   ORDER BY checked_at DESC LIMIT ?`;
      const stmt = db.prepare(sql);
      return category ? stmt.all(category, limit) : stmt.all(limit);
    },

    // upsertPriceAuditItem only adds/updates — a product that matched last
    // run but no longer qualifies under stricter criteria (or a site that's
    // stopped carrying it) is never removed on its own, leaving stale rows
    // behind. Each match-local.js run calls this first so every run reports
    // exactly what it found, not a running union with past runs.
    async deletePriceAuditItemsByCategory(category) {
      db.prepare('DELETE FROM price_audit_items WHERE category = ?').run(category);
    },

    async listUnsupportedPartners() {
      return selUnsupported.all();
    },

    async addUnsupportedPartner({ name, kaprukaUrl, partnerSite, reason, detail }) {
      insUnsupported.run(nowIso(), name || null, kaprukaUrl || null, partnerSite, reason || null, detail || null);
    },

    async countBulkRefreshesSince(sinceIso) {
      return selBulkRefreshCount.get(sinceIso).n;
    },

    async logBulkRefreshRequest() {
      insBulkRefresh.run(nowIso());
    },

    async listPartnerRows() {
      return selPartners.all().map(rowToPartner);
    },

    async getPartnerRow(id) {
      const row = selPartner.get(id);
      return row ? rowToPartner(row) : null;
    },

    async insertPartnerRow(p) {
      insPartner.run(
        p.id, p.name, p.kaprukaUrl || null, p.kaprukaSlug || null, p.partnerSite,
        p.partnerLabel || null, p.platform || null, p.viaBrowser ? 1 : 0, nowIso(),
      );
      return p;
    },

    async requestPartnerRefresh(id) {
      updPartnerRefreshRequest.run(nowIso(), id);
    },

    async getIntlGiftPairings(country) {
      const out = {};
      for (const r of selPairings.all(country)) {
        out[r.kapruka_sku] = { fnpUrl: r.fnp_url, matchSource: r.match_source, matchConfidence: r.match_confidence };
      }
      return out;
    },

    async setIntlGiftPairing(country, sku, fnpUrl, matchSource, matchConfidence) {
      if (!fnpUrl) {
        delPairing.run(country, sku);
        return;
      }
      upsertPairing.run(country, sku, fnpUrl, matchSource || null, matchConfidence || null, nowIso());
    },

    async getIntlGiftSnapshot(country) {
      const row = selSnapshot.get(country);
      return row ? JSON.parse(row.payload_json) : null;
    },

    async setIntlGiftSnapshot(country, payload) {
      upsertSnapshot.run(country, nowIso(), JSON.stringify(payload));
    },

    async savePriceCheck({ category, query, result }) {
      const info = insChk.run(
        nowIso(),
        category,
        query?.name ?? null,
        query?.description ?? null,
        (result.results || []).length,
        (result.discovered || []).length,
        JSON.stringify(result),
      );
      return Number(info.lastInsertRowid);
    },

    async saveComparisonRun(data) {
      const s = data.summary;
      const info = insRun.run(
        data.generatedAt || nowIso(),
        data.partner.id,
        data.partner.name,
        data.partner.kaprukaSlug,
        data.partner.partnerSite,
        data.partner.platform,
        data.catalogCounts.kapruka,
        data.catalogCounts.partner,
        s.matched,
        s.kaprukaHigher,
        s.kaprukaLower,
        s.same,
        s.onlyKapruka,
        s.onlyPartner,
        JSON.stringify(data),
      );
      return Number(info.lastInsertRowid);
    },

    async recentPriceChecks(limit = 50) {
      return db
        .prepare(`SELECT id, created_at, category, query_name, description, result_count, discovered_count
                  FROM price_checks ORDER BY id DESC LIMIT ?`)
        .all(limit);
    },

    async recentComparisonRuns(limit = 50, partnerId = null) {
      const sql = `SELECT id, created_at, partner_id, partner_name, platform, kapruka_count, partner_count,
                     matched, kapruka_higher, kapruka_lower, same_price, only_kapruka, only_partner
                   FROM comparison_runs ${partnerId ? 'WHERE partner_id = ?' : ''}
                   ORDER BY id DESC LIMIT ?`;
      const stmt = db.prepare(sql);
      return partnerId ? stmt.all(partnerId, limit) : stmt.all(limit);
    },

    async getComparisonRun(id) {
      const row = db.prepare('SELECT payload_json FROM comparison_runs WHERE id = ?').get(id);
      return row ? JSON.parse(row.payload_json) : null;
    },

    async allPriceCheckRows() {
      return db.prepare('SELECT id, created_at, payload_json FROM price_checks ORDER BY id').all();
    },

    async allComparisonRows(partnerId = null) {
      const sql = `SELECT id, created_at, payload_json FROM comparison_runs
                   ${partnerId ? 'WHERE partner_id = ?' : ''} ORDER BY id`;
      const stmt = db.prepare(sql);
      return partnerId ? stmt.all(partnerId) : stmt.all();
    },
  };
}
