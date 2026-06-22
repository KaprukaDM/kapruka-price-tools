// Persistence for both tools, backed by a single portable SQLite file
// (data/price-tools.db) so the data can be queried by anything else later.
//
// Two tables:
//   price_checks     - one row per Price Checker query (/api/match)
//   comparison_runs  - one row per partner price reconciliation that actually
//                      recomputed (a forced refresh or a cache miss — cached
//                      responses are NOT re-stored)
//
// Each row keeps flat summary columns for easy SQL plus a full JSON payload so
// nothing is lost. Uses Node's built-in node:sqlite (no native build needed).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Note: node:sqlite is still "experimental" in Node 22, so it prints a one-line
// ExperimentalWarning at startup. That's expected and harmless.

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets the host point the SQLite file at a persistent disk (e.g. a
// Render mounted disk). Defaults to ./data for local use.
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

const nowIso = () => new Date().toISOString();

// ---- Price Checker ----

const insChk = db.prepare(`
  INSERT INTO price_checks (created_at, category, query_name, description, result_count, discovered_count, payload_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

export function savePriceCheck({ category, query, result }) {
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
}

// ---- Partner Comparison ----

const insRun = db.prepare(`
  INSERT INTO comparison_runs
    (created_at, partner_id, partner_name, kapruka_slug, partner_site, platform,
     kapruka_count, partner_count, matched, kapruka_higher, kapruka_lower,
     same_price, only_kapruka, only_partner, payload_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function saveComparisonRun(data) {
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
}

// ---- History reads (for downstream use) ----

export function recentPriceChecks(limit = 50) {
  return db
    .prepare(`SELECT id, created_at, category, query_name, description, result_count, discovered_count
              FROM price_checks ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

export function recentComparisonRuns(limit = 50, partnerId = null) {
  const sql = `SELECT id, created_at, partner_id, partner_name, platform, kapruka_count, partner_count,
                 matched, kapruka_higher, kapruka_lower, same_price, only_kapruka, only_partner
               FROM comparison_runs ${partnerId ? 'WHERE partner_id = ?' : ''}
               ORDER BY id DESC LIMIT ?`;
  const stmt = db.prepare(sql);
  return partnerId ? stmt.all(partnerId, limit) : stmt.all(limit);
}

export function getComparisonRun(id) {
  const row = db.prepare('SELECT payload_json FROM comparison_runs WHERE id = ?').get(id);
  return row ? JSON.parse(row.payload_json) : null;
}

export default db;
