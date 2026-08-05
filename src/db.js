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
//   price_audit_items  - one row per (Kapruka product, competitor site) pair from
//                         the local product-price audit (src/electronics-audit/).
//                         Unlike comparison_runs (one partner's full catalogue vs
//                         Kapruka's), this audits MANY competitor sites at once by
//                         querying each site's own search endpoint per product, so
//                         results land here incrementally, one upsert per pair,
//                         rather than one big payload per run.
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
    try {
      await rest.recentComparisonRuns(1);
      return { backend: rest, kind: 'supabase-rest' };
    } catch (err) {
      console.warn(`! Supabase REST unreachable (${err.message}); falling back to local SQLite.`);
    }
  }
  return { backend: await makeSqliteBackend(), kind: 'sqlite' };
}

const { backend, kind: storageKind } = await selectBackend();
export { storageKind };

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
export const upsertPriceAuditItem = (item) => backend.upsertPriceAuditItem(item);
export const getPriceAuditItems = (opts) => backend.getPriceAuditItems(opts);

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
  `);

  return {
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

  async function insert(table, row) {
    const rows = await restFetch(`/${table}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    return Number(rows[0].id);
  }

  return {
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
      const filter = category ? `&category=eq.${encodeURIComponent(category)}` : '';
      return restFetch(`/price_audit_items?select=*&order=checked_at.desc&limit=${limit}${filter}`);
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
      const rows = await restFetch(`/price_checks?select=id,created_at,payload&order=id.asc`);
      return rows.map((r) => ({ id: r.id, created_at: r.created_at, payload_json: JSON.stringify(r.payload) }));
    },

    async allComparisonRows(partnerId = null) {
      const filter = partnerId ? `&partner_id=eq.${encodeURIComponent(partnerId)}` : '';
      const rows = await restFetch(`/comparison_runs?select=id,created_at,payload&order=id.asc${filter}`);
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
  `);

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

    async listUnsupportedPartners() {
      return selUnsupported.all();
    },

    async addUnsupportedPartner({ name, kaprukaUrl, partnerSite, reason, detail }) {
      insUnsupported.run(nowIso(), name || null, kaprukaUrl || null, partnerSite, reason || null, detail || null);
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
