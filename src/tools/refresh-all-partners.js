// Standalone refresh job: re-runs every partner's Kapruka-vs-partner
// reconciliation and saves the results to whatever storage backend .env
// points at (Supabase REST, Postgres, or local SQLite — see src/db.js).
//
// Why this exists separately from the daily refresh already built into
// src/server.js: that one only fires while the Express server process is
// actively running, and only from wherever that process happens to be
// hosted. Kapruka geo-detects the connecting IP and serves USD instead of
// LKR pricing to non-Sri-Lankan hosts, which shows up as "Price missing" on
// products the JSON-LD price map doesn't cover (see comments in
// src/compare/sources.js). Running this script on a schedule from a machine
// that already gets correct LKR pricing (e.g. via Windows Task Scheduler on
// an office/SL-based box) sidesteps that without needing a proxy — whatever
// serves the dashboard just reads the latest stored run per partner.
//
// Deliberately narrow, not "gap-fill everything": this only rescrapes a
// partner that either (a) has no stored run at all yet (brand new), or
// (b) has a pending "Refresh" request (see public/compare.js's Refresh
// button + POST /api/compare/refresh-request) newer than its latest run.
// A partner that already has *some* data is left alone even if it still has
// price-missing entries — re-checking is now an explicit, user-initiated
// action (the Refresh button), not something this job does on its own for
// every partner, every run. That's a deliberate choice: it keeps this job
// fast and avoids repeatedly hitting Kapruka/partner sites (see the HTTP 429
// rate-limiting noted elsewhere) for partners nobody has asked to re-check.
//
// Where the schedule lives (changed 2026-09-08): this used to be driven by a
// hidden Windows Scheduled Task ("Kapruka Price Refresh", every 15 min) that
// nobody could see from the dashboards — if it silently stopped, the only clue
// was stale data. That task has been deleted; the same work now runs *inside*
// the app (src/server.js registers it as the `pending-refresh` scheduled job)
// and its interval, last run, next run and last result are shown on the
// Partner Overpriced dashboard, with a "Run now" button next to them.
//
// Usage (still runnable standalone, e.g. a one-off from the terminal):
//   node src/tools/refresh-all-partners.js

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runComparison } from '../compare/run.js';
import { listPartners } from '../compare/partners.js';
import { saveComparisonRun, recentComparisonRuns, storageKind } from '../db.js';

// The job itself, exported so the in-app scheduler can call it directly
// instead of shelling out to a separate process. `log` lets the server route
// output wherever it wants; defaults to the console for the CLI path.
export async function refreshPendingPartners({ log = console.log } = {}) {
  const partners = await listPartners();
  log(`Checking ${partners.length} partner(s) for new additions / refresh requests…`);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of partners) {
    const [latest] = await recentComparisonRuns(1, p.id);
    const refreshPending = p.refreshRequestedAt &&
      (!latest || new Date(p.refreshRequestedAt) > new Date(latest.created_at));
    if (latest && !refreshPending) {
      log(`  · ${p.name}: already has data, no refresh requested — skipping`);
      skipped += 1;
      continue;
    }
    try {
      const data = await runComparison({ partnerId: p.id, force: true });
      if (!data.cached) await saveComparisonRun(data);
      const pm = data.summary.priceMissing;
      log(`  ✓ ${p.name}: ${data.summary.kaprukaHigher} overpriced of ${data.summary.matched} matched` +
        (pm ? `, ${pm} still price-missing` : ' — fully complete'));
      refreshed += 1;
    } catch (err) {
      log(`  ! ${p.name}: ${err.message}`);
      failed += 1;
    }
  }
  log(`Done — ${refreshed} refreshed, ${skipped} already have data, ${failed} failed.`);
  return { total: partners.length, refreshed, skipped, failed };
}

async function main() {
  console.log(`Storage backend: ${storageKind}`);
  const { refreshed, skipped, failed } = await refreshPendingPartners();
  if (failed > 0 && refreshed === 0 && skipped === 0) process.exitCode = 1;
}

// Only run the CLI path when this file is the entry point — importing it from
// the server must not kick off a refresh on import.
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((err) => {
    console.error('Refresh failed:', err);
    process.exitCode = 1;
  });
}
