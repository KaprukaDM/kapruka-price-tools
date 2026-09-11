// Full sweep from the CLI: force-refresh EVERY configured partner regardless of
// whether it already has stored data, and save each result to whatever storage
// backend .env points at (see src/db.js).
//
// How this differs from the other two refresh paths:
//   · src/tools/refresh-all-partners.js — the routine scheduled job body.
//     Deliberately narrow: only partners with no stored run yet, or a pending
//     "Refresh" request. Leaves everything else alone.
//   · src/server.js's `full-sweep` job — same "every partner" idea, but it
//     runs in-process and refuses to scrape unless SCRAPE_ON_ADD=1 marks the
//     host as trusted-geo (otherwise it only *queues* refresh requests).
//   · this script — an explicit, operator-initiated full sweep of all
//     partners, runnable standalone without the server.
//
// IMPORTANT — only run this from a host that gets LKR pricing from Kapruka.
// Kapruka geo-detects the connecting IP and serves USD abroad, which the
// scraper drops (see src/compare/sources.js). Force-refreshing from a bad-geo
// host would overwrite good stored data with "price missing" for every
// partner. The script checks this before doing anything and aborts unless
// --skip-geo-check is passed.
//
// Usage:
//   node src/tools/force-refresh-all-partners.js              # all partners
//   node src/tools/force-refresh-all-partners.js --concurrency=4
//   node src/tools/force-refresh-all-partners.js --only=thinex,gmc
//   node src/tools/force-refresh-all-partners.js --report=data/my-run.json
//
// Concurrency exists because a single partner can take minutes (catalogue
// paging plus one stock check per matched product, throttled to stay under
// Kapruka's rate limit), so a strictly sequential sweep of ~130 partners runs
// for hours. Keep it low — every worker adds to the same per-IP request rate
// that trips Kapruka's 429 limiter. The report counts 429s seen per partner so
// a too-high value is visible rather than silent.

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runComparison } from '../compare/run.js';
import { rateLimitRetryCount } from '../compare/sources.js';
import { listPartners } from '../compare/partners.js';
import { saveComparisonRun, storageKind } from '../db.js';

const DEFAULT_CONCURRENCY = 4;
const GEO_PROBE_URL = 'https://www.kapruka.com/partner/joey-clothing';

function parseArgs(argv) {
  const opts = { concurrency: DEFAULT_CONCURRENCY, only: null, report: null, skipGeoCheck: false };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'concurrency') opts.concurrency = Math.max(1, Number(value) || DEFAULT_CONCURRENCY);
    else if (key === 'only') opts.only = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'report') opts.report = value;
    else if (key === 'skip-geo-check') opts.skipGeoCheck = true;
  }
  return opts;
}

// Kapruka serves LKR only to Sri-Lankan IPs; anywhere else the JSON-LD comes
// back USD and every price is dropped as unusable. Cheap up-front check so a
// bad-geo host fails loudly in seconds instead of quietly writing ~130 runs of
// "price missing" over good data.
async function checkKaprukaGeo() {
  const res = await fetch(GEO_PROBE_URL, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!res.ok) return { ok: false, reason: `probe page returned HTTP ${res.status}` };
  const html = await res.text();
  const currencies = new Set(
    [...html.matchAll(/priceCurrency"?\s*:\s*"?([A-Z]{3})/g)].map((m) => m[1])
  );
  if (!currencies.size) return { ok: false, reason: 'no priceCurrency found on the probe page' };
  if (!currencies.has('LKR')) {
    return { ok: false, reason: `Kapruka served ${[...currencies].join('/')}, not LKR — this host has bad geo-pricing` };
  }
  return { ok: true, currencies: [...currencies] };
}

// Classify a failure so the run report says *why* a partner is broken rather
// than just echoing a stack-trace message.
function classifyError(message) {
  const m = String(message).toLowerCase();
  if (m.includes('429') || m.includes('rate limit')) return 'rate-limited';
  if (m.includes('no valid kapruka link')) return 'misconfigured';
  if (/\b(403|401)\b|forbidden|unauthor/.test(m)) return 'blocked';
  if (/enotfound|eai_again|dns/.test(m)) return 'dns-failure';
  if (/timeout|etimedout|abort/.test(m)) return 'timeout';
  if (/econnrefused|econnreset|socket|network|fetch failed/.test(m)) return 'network';
  if (/\b5\d\d\b/.test(m)) return 'partner-site-error';
  if (m.includes('not woocommerce') || m.includes('unsupported')) return 'unsupported-platform';
  return 'other';
}

async function refreshOne(partner, index, total) {
  const startedAt = Date.now();
  const label = `[${index + 1}/${total}] ${partner.name}`;
  // Rate-limit retries are counted globally in sources.js, not per partner:
  // with a worker pool several partners share the same per-IP budget at once,
  // so attributing a 429 to one of them would be a guess. Snapshot the global
  // counter around this partner only as a rough "how busy was the limiter
  // while this ran" signal.
  const rateLimitBefore = rateLimitRetryCount();
  const log = () => {};

  try {
    const data = await runComparison({ partnerId: partner.id, force: true, log });
    let saved = false;
    if (!data.cached) {
      await saveComparisonRun(data);
      saved = true;
    }
    const s = data.summary || {};
    const record = {
      id: partner.id,
      name: partner.name,
      ok: true,
      saved,
      siteActive: data.partner?.siteActive !== false,
      platform: data.partner?.platform || null,
      durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      kaprukaProducts: data.catalogCounts?.kapruka ?? null,
      partnerProducts: data.catalogCounts?.partner ?? null,
      matched: s.matched ?? 0,
      same: s.same ?? 0,
      kaprukaHigher: s.kaprukaHigher ?? 0,
      kaprukaLower: s.kaprukaLower ?? 0,
      priceMissing: s.priceMissing ?? 0,
      onlyKapruka: s.onlyKapruka ?? 0,
      onlyPartner: s.onlyPartner ?? 0,
      rateLimitRetriesDuringRun: rateLimitRetryCount() - rateLimitBefore,
    };
    console.log(
      `${label}: ✓ ${record.matched} matched (${record.kaprukaHigher} overpriced, ${record.priceMissing} price-missing), ` +
        `${record.kaprukaProducts} Kapruka / ${record.partnerProducts} partner products, ${record.durationSec}s` +
        (record.siteActive ? '' : ' — partner site offline, reused last known data')
    );
    return record;
  } catch (err) {
    const reason = classifyError(err.message);
    console.warn(`${label}: ! FAILED (${reason}) — ${err.message}`);
    return {
      id: partner.id,
      name: partner.name,
      ok: false,
      saved: false,
      reason,
      error: err.message,
      durationSec: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      rateLimitRetriesDuringRun: rateLimitRetryCount() - rateLimitBefore,
    };
  }
}

// Fixed-size worker pool over the partner list, preserving input order in the
// results array so the report reads the same way every run.
async function runPool(partners, concurrency, worker) {
  const results = new Array(partners.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, partners.length) }, async () => {
    while (cursor < partners.length) {
      const i = cursor++;
      results[i] = await worker(partners[i], i, partners.length);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date();

  console.log(`Storage backend: ${storageKind}`);

  if (opts.skipGeoCheck) {
    console.warn('! Skipping the Kapruka geo check (--skip-geo-check) — prices may be written as USD/missing.');
  } else {
    const geo = await checkKaprukaGeo();
    if (!geo.ok) {
      console.error(`Aborting: ${geo.reason}.`);
      console.error('Run this from a Sri-Lanka-geo host, set SCRAPE_PROXY, or pass --skip-geo-check if you really mean it.');
      process.exitCode = 1;
      return;
    }
    console.log(`Kapruka geo check: OK (priceCurrency = ${geo.currencies.join(', ')})`);
  }

  let partners = await listPartners();
  if (opts.only) {
    const wanted = new Set(opts.only);
    partners = partners.filter((p) => wanted.has(p.id));
    const missing = opts.only.filter((id) => !partners.some((p) => p.id === id));
    if (missing.length) console.warn(`! Unknown partner id(s) ignored: ${missing.join(', ')}`);
  }

  console.log(
    `Force-refreshing ${partners.length} partner(s) with concurrency ${opts.concurrency} — started ${startedAt.toISOString()}`
  );

  const results = await runPool(partners, opts.concurrency, refreshOne);

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const finishedAt = new Date();
  const totals = ok.reduce(
    (acc, r) => {
      acc.matched += r.matched;
      acc.kaprukaHigher += r.kaprukaHigher;
      acc.priceMissing += r.priceMissing;
      acc.kaprukaProducts += r.kaprukaProducts || 0;
      acc.partnerProducts += r.partnerProducts || 0;
      return acc;
    },
    { matched: 0, kaprukaHigher: 0, priceMissing: 0, kaprukaProducts: 0, partnerProducts: 0 }
  );

  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMin: Number(((finishedAt - startedAt) / 60000).toFixed(1)),
    storage: storageKind,
    concurrency: opts.concurrency,
    rateLimitRetriesTotal: rateLimitRetryCount(),
    partners: results.length,
    refreshed: ok.length,
    failed: failed.length,
    totals,
    failuresByReason: failed.reduce((acc, r) => {
      acc[r.reason] = (acc[r.reason] || 0) + 1;
      return acc;
    }, {}),
    results,
  };

  const reportPath = path.resolve(
    process.cwd(),
    opts.report || `data/refresh-report-${startedAt.toISOString().replace(/[:.]/g, '-')}.json`
  );
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(
    `\nDone in ${report.durationMin}min — ${ok.length} refreshed, ${failed.length} failed ` +
      `(of ${results.length} stores). ${totals.matched} matched products, ` +
      `${totals.kaprukaHigher} where Kapruka is overpriced, ${totals.priceMissing} still price-missing. ` +
      `${report.rateLimitRetriesTotal} HTTP 429 retries along the way.`
  );
  if (failed.length) {
    console.log('Failures by reason:', report.failuresByReason);
    for (const f of failed) console.log(`  · ${f.name} (${f.id}) — ${f.reason}: ${f.error}`);
  }
  console.log(`Report written to ${reportPath}`);

  if (ok.length === 0 && results.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Force refresh failed:', err);
  process.exitCode = 1;
});
