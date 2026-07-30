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
// Gap-filling, not a full re-scrape every time: a partner whose latest
// stored run already has zero price-missing entries is left alone — no
// point re-hitting a site that's already complete. Only partners with no
// stored run yet, or with price-missing entries in their latest run, get
// rescraped. This also cuts down on how often we hit Kapruka/partner sites
// (see the HTTP 429 rate-limiting noted elsewhere), since a fully-clean
// partner stops being requested at all once it's done.
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
import { saveComparisonRun, recentComparisonRuns, storageKind } from '../db.js';

// price_missing isn't stored as its own column — derive it from the summary
// columns that are: matched = same + kapruka_higher + kapruka_lower + price_missing.
function priceMissingCount(row) {
  return row.matched - row.kapruka_higher - row.kapruka_lower - row.same_price;
}

async function main() {
  console.log(`Storage backend: ${storageKind}`);
  const partners = await listPartners();
  console.log(`Checking ${partners.length} partner(s) for gaps to fill…`);

  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of partners) {
    const [latest] = await recentComparisonRuns(1, p.id);
    if (latest && latest.matched > 0 && priceMissingCount(latest) <= 0) {
      console.log(`  · ${p.name}: already complete (0 price-missing of ${latest.matched}) — skipping`);
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
  console.log(`Done — ${refreshed} refreshed, ${skipped} already complete, ${failed} failed.`);
  if (failed > 0 && refreshed === 0 && skipped === 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Refresh failed:', err);
  process.exitCode = 1;
});
