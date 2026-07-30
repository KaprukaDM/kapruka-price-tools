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
// Usage:
//   node src/tools/refresh-all-partners.js
//
// Schedule on Windows (daily at 03:00, adjust path/time as needed):
//   schtasks /create /tn "Kapruka Price Refresh" /sc daily /st 03:00 ^
//     /tr "node \"C:\Users\fari\Desktop\Price Analysis\src\tools\refresh-all-partners.js\""

import 'dotenv/config';
import { runComparison } from '../compare/run.js';
import { listPartners } from '../compare/partners.js';
import { saveComparisonRun, storageKind } from '../db.js';

async function main() {
  console.log(`Storage backend: ${storageKind}`);
  const partners = await listPartners();
  console.log(`Refreshing ${partners.length} partner comparison(s)…`);

  let ok = 0;
  let failed = 0;
  for (const p of partners) {
    try {
      const data = await runComparison({ partnerId: p.id, force: true });
      if (!data.cached) await saveComparisonRun(data);
      console.log(`  ✓ ${p.name}: ${data.summary.kaprukaHigher} overpriced of ${data.summary.matched} matched` +
        (data.summary.priceMissing ? `, ${data.summary.priceMissing} price-missing` : ''));
      ok += 1;
    } catch (err) {
      console.warn(`  ! ${p.name}: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`Done — ${ok} succeeded, ${failed} failed.`);
  if (failed > 0 && ok === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exitCode = 1;
});
