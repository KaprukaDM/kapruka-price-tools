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
// Two tables either way:
//   price_checks     - one row per Price Checker query (/api/match)
//   comparison_runs  - one row per partner reconciliation that actually recomputed
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

export const savePriceCheck = (args) => backend.savePriceCheck(args);
export const saveComparisonRun = (data) => backend.saveComparisonRun(data);
export const recentPriceChecks = (limit = 50) => backend.recentPriceChecks(limit);
export const recentComparisonRuns = (limit = 50, partnerId = null) =>
  backend.recentComparisonRuns(limit, partnerId);
export const getComparisonRun = (id) => backend.getComparisonRun(id);
export const allPriceCheckRows = () => backend.allPriceCheckRows();
export const allComparisonRows = (partnerId = null) => backend.allComparisonRows(partnerId);

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
  `);

  return {
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
    return res.status === 204 ? null : res.json();
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

  return {
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
