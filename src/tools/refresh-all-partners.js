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
// Usage:
//   node src/tools/refresh-all-partners.js
//
// Schedule on Windows (every 15 min, adjust as needed):
//   schtasks /create /tn "Kapruka Price Refresh" /sc minute /mo 15 ^
//     /tr "node \"C:\Users\fari\Desktop\Price Analysis\src\tools\refresh-all-partners.js\""

import 'dotenv/config';
import { runComparison } from '../compare/run.js';
import { listPartners } from '../compare/partners.js';
import { saveComparisonRun, recentComparisonRuns, storageKind } from '../db.js';

async function main() {
  console.log(`Storage backend: ${storageKind}`);
  const partners = await listPartners();
  console.log(`Checking ${partners.length} partner(s) for new additions / refresh requests…`);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of partners) {
    const [latest] = await recentComparisonRuns(1, p.id);
    const refreshPending = p.refreshRequestedAt &&
      (!latest || new Date(p.refreshRequestedAt) > new Date(latest.created_at));
    if (latest && !refreshPending) {
      console.log(`  · ${p.name}: already has data, no refresh requested — skipping`);
      skipped += 1;
      continue;
    }
    try {
      const data = await runComparison({ partnerId: p.id, force: true });
      if (!data.cached) await saveComparisonRun(data);
      const pm = data.summary.priceMissing;
      console.log(`  ✓ ${p.name}: ${data.summary.kaprukaHigher} overpriced of ${data.summary.matched} matched` +
        (pm ? `, ${pm} still price-missing` : ' — fully complete'));
      refreshed += 1;
    } catch (err) {
      console.warn(`  ! ${p.name}: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`Done — ${refreshed} refreshed, ${skipped} already have data, ${failed} failed.`);
  if (failed > 0 && refreshed === 0 && skipped === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exitCode = 1;
});
