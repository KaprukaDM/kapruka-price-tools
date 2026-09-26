// Export every partner's own website as a spreadsheet-ready CSV — the list the
// SEO side needs for link-building/outreach (partner sites are the warmest
// backlink targets Kapruka has: there's already a commercial relationship and
// their products are literally listed on kapruka.com).
//
// Where the data comes from, in order:
//   1. The partner registry itself (Supabase/Postgres/SQLite via src/db.js) —
//      authoritative, needs DATABASE_URL or SUPABASE_URL+SUPABASE_SERVICE_KEY.
//   2. data/compare-cache/*.json — the last comparison run cached per partner.
//      Used to fill in site health (is the site even reachable?) and the last
//      checked date, and as a complete fallback when no DB is configured, so
//      this is still runnable on a checkout with no credentials.
//
// A dead partner site is worthless as a link target, so site_status /
// site_live come along in the export rather than a bare domain list.
//
// Usage:
//   node src/tools/export-partner-sites.js                  -> data/partner-sites.csv
//   node src/tools/export-partner-sites.js "C:/path/out.csv"
//   npm run export:partner-sites

import 'dotenv/config';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CACHE_DIR = path.resolve(
  process.cwd(),
  process.env.COMPARE_CACHE_DIR || 'data/compare-cache',
);

const hostOf = (site) => {
  if (!site) return '';
  try {
    return new URL(site.startsWith('http') ? site : `https://${site}`).host.replace(/^www\./, '');
  } catch {
    return String(site);
  }
};

// Partner + site-health snapshot out of each cached comparison run.
async function readCachedPartners() {
  let files = [];
  try {
    files = await readdir(CACHE_DIR);
  } catch {
    return new Map();
  }
  const byId = new Map();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const run = JSON.parse(await readFile(path.join(CACHE_DIR, file), 'utf8'));
      const p = run?.partner;
      if (!p?.id) continue;
      byId.set(p.id, {
        id: p.id,
        name: p.name || p.id,
        partnerSite: p.partnerSite || '',
        partnerLabel: p.partnerLabel || '',
        platform: p.platform || '',
        kaprukaLink: p.kaprukaLink || '',
        siteActive: p.siteActive,
        siteStatus: p.siteStatus || '',
        siteStatusDetail: p.siteStatusDetail || '',
        checkedAt: run.checkedAt || run.generatedAt || '',
        partnerProducts: run.catalogCounts?.partner ?? '',
      });
    } catch {
      // A half-written cache file shouldn't kill the whole export.
    }
  }
  return byId;
}

// Registry rows, when a DB is configured. Returns [] otherwise (or on error)
// so the cache fallback can carry the export on its own.
async function readRegistryPartners() {
  if (!process.env.DATABASE_URL && !(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)) {
    return { rows: [], source: 'none' };
  }
  try {
    const { listPartnerRows } = await import('../db.js');
    return { rows: await listPartnerRows(), source: 'registry' };
  } catch (err) {
    console.warn(`Registry read failed (${err.message}) — falling back to ${CACHE_DIR}`);
    return { rows: [], source: 'none' };
  }
}

export async function collectPartnerSites() {
  const cached = await readCachedPartners();
  const { rows } = await readRegistryPartners();

  const merged = new Map();
  for (const row of rows) {
    const c = cached.get(row.id) || {};
    merged.set(row.id, {
      id: row.id,
      name: row.name || c.name || row.id,
      partnerSite: row.partnerSite || c.partnerSite || '',
      partnerLabel: row.partnerLabel || c.partnerLabel || '',
      platform: row.platform || c.platform || '',
      kaprukaLink:
        row.kaprukaUrl ||
        c.kaprukaLink ||
        (row.kaprukaSlug ? `https://www.kapruka.com/partner/${row.kaprukaSlug}` : ''),
      siteActive: c.siteActive,
      siteStatus: c.siteStatus || '',
      checkedAt: c.checkedAt || '',
      partnerProducts: c.partnerProducts ?? '',
      inRegistry: true,
    });
  }
  for (const [id, c] of cached) {
    if (!merged.has(id)) merged.set(id, { ...c, inRegistry: rows.length === 0 ? '' : false });
  }

  // One row per distinct domain — a couple of partners can sit on the same
  // site, and a backlink target is a domain, not a storefront.
  const byHost = new Map();
  for (const p of merged.values()) {
    const host = hostOf(p.partnerSite);
    if (!host) continue;
    const existing = byHost.get(host);
    if (!existing) {
      byHost.set(host, { ...p, host, partners: [p.name] });
      continue;
    }
    existing.partners.push(p.name);
    if (!existing.checkedAt || (p.checkedAt && p.checkedAt > existing.checkedAt)) {
      existing.siteActive = p.siteActive;
      existing.siteStatus = p.siteStatus;
      existing.checkedAt = p.checkedAt;
    }
  }
  return [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host));
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function partnerSitesCsv(sites) {
  const header = [
    'domain',
    'website',
    'partner_name',
    'kapruka_partner_page',
    'platform',
    'site_live',
    'site_status',
    'partner_products',
    'last_checked',
  ];
  const lines = [header.join(',')];
  for (const s of sites) {
    lines.push(
      [
        s.host,
        s.partnerSite,
        s.partners.join(' / '),
        s.kaprukaLink,
        s.platform,
        s.siteActive === false ? 'no' : s.siteActive === true ? 'yes' : '',
        s.siteStatus,
        s.partnerProducts,
        s.checkedAt ? s.checkedAt.slice(0, 10) : '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  // BOM so Excel/Sheets read UTF-8 names correctly (same as src/export.js).
  return `\uFEFF${lines.join('\n')}\n`;
}

async function main() {
  const out = path.resolve(process.cwd(), process.argv[2] || 'data/partner-sites.csv');
  const sites = await collectPartnerSites();
  if (!sites.length) {
    console.error(
      'No partner sites found — configure DATABASE_URL / SUPABASE_URL+SUPABASE_SERVICE_KEY, ' +
        `or run a comparison first so ${CACHE_DIR} has cached runs.`,
    );
    process.exitCode = 1;
    return;
  }
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, partnerSitesCsv(sites), 'utf8');
  const live = sites.filter((s) => s.siteActive !== false).length;
  console.log(`${sites.length} partner domains (${live} reachable at last check) -> ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
