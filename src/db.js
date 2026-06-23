// Persistence for both tools. Two backends behind one async API:
//
//   • Postgres (Supabase) — used when DATABASE_URL is set (production). Survives
//     deploys/restarts and is queryable from Supabase.
//   • SQLite (node:sqlite) — local fallback when DATABASE_URL is absent, so
//     development needs no database setup. Portable file at data/price-tools.db.
//
// Two tables either way:
//   price_checks     - one row per Price Checker query (/api/match)
//   comparison_runs  - one row per partner reconciliation that actually recomputed
//
// Each row keeps flat summary columns for easy SQL plus a full JSON payload so
// nothing is lost. ALL exported functions are async (Postgres is async; the
// SQLite path resolves immediately).

import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL || '';
const nowIso = () => new Date().toISOString();

// Pick the backend once at load.
const backend = DATABASE_URL ? await makePostgresBackend(DATABASE_URL) : await makeSqliteBackend();

export const savePriceCheck = (args) => backend.savePriceCheck(args);
export const saveComparisonRun = (data) => backend.saveComparisonRun(data);
export const recentPriceChecks = (limit = 50) => backend.recentPriceChecks(limit);
export const recentComparisonRuns = (limit = 50, partnerId = null) =>
  backend.recentComparisonRuns(limit, partnerId);
export const getComparisonRun = (id) => backend.getComparisonRun(id);
export const allPriceCheckRows = () => backend.allPriceCheckRows();
export const allComparisonRows = (partnerId = null) => backend.allComparisonRows(partnerId);

export const storageKind = DATABASE_URL ? 'postgres' : 'sqlite';

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
