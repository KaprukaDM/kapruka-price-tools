// One-off: force-refresh EVERY configured partner regardless of whether it
// already has stored data, so all runs pick up real Kapruka stock status
// (see the parseKaprukaPage() fix in compare/sources.js and the new Out of
// Stock dashboard). Unlike src/tools/refresh-all-partners.js (the routine
// scheduled job, which deliberately only touches new/refresh-requested
// partners), this is a one-time backfill — safe to delete after running.
//
// Usage:
//   node src/tools/force-refresh-all-partners.js

import 'dotenv/config';
import { runComparison } from '../compare/run.js';
import { listPartners } from '../compare/partners.js';
import { saveComparisonRun, storageKind } from '../db.js';

async function main() {
  console.log(`Storage backend: ${storageKind}`);
  const partners = await listPartners();
  console.log(`Force-refreshing ${partners.length} partner(s)…`);

  let ok = 0;
  let failed = 0;
  for (const [i, p] of partners.entries()) {
    try {
      const data = await runComparison({ partnerId: p.id, force: true });
      if (!data.cached) await saveComparisonRun(data);
      const pm = data.summary.priceMissing;
      console.log(`[${i + 1}/${partners.length}] ✓ ${p.name}: ${data.summary.kaprukaHigher} overpriced of ${data.summary.matched} matched` +
        (pm ? `, ${pm} still price-missing` : ' — fully complete'));
      ok += 1;
    } catch (err) {
      console.warn(`[${i + 1}/${partners.length}] ! ${p.name}: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`Done — ${ok} refreshed, ${failed} failed.`);
}

main().catch((err) => {
  console.error('Force refresh failed:', err);
  process.exitCode = 1;
});
