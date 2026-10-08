// One-off: retry the specific partners that failed in the last
// force-refresh-all-partners.js run (fetch failures / Kapruka HTTP 429s).
// Safe to delete after running.
//
// Usage:
//   node src/tools/retry-failed-partners.js

import 'dotenv/config';
import { runComparison } from '../compare/run.js';
import { listPartners } from '../compare/partners.js';
import { saveComparisonRun, storageKind } from '../db.js';

const NAMES = [
  'Kaaya Ayurveda',
  'Dr Rashel',
  'Secret Touch',
  'Greenelectric',
  'Nature Fresh',
  'The Ceylon Bible Society',
  'Midnightdivas',
  'Three Q International',
  'Stripes and Checks Inc',
  'Ekko',
  'Leena Clothing',
  'Noritake Lanka Porcelain',
];

async function main() {
  console.log(`Storage backend: ${storageKind}`);
  const all = await listPartners();
  const targets = NAMES.map((n) => all.find((p) => p.name === n)).filter(Boolean);
  const missing = NAMES.filter((n) => !all.some((p) => p.name === n));
  if (missing.length) console.warn(`Not found in partner list: ${missing.join(', ')}`);
  console.log(`Retrying ${targets.length} partner(s)…`);

  let ok = 0;
  let failed = 0;
  for (const [i, p] of targets.entries()) {
    try {
      const data = await runComparison({ partnerId: p.id, force: true });
      if (!data.cached) await saveComparisonRun(data);
      const pm = data.summary.priceMissing;
      console.log(`[${i + 1}/${targets.length}] ✓ ${p.name}: ${data.summary.kaprukaHigher} overpriced of ${data.summary.matched} matched` +
        (pm ? `, ${pm} still price-missing` : ' — fully complete'));
      ok += 1;
    } catch (err) {
      console.warn(`[${i + 1}/${targets.length}] ! ${p.name}: ${err.message}`);
      failed += 1;
    }
  }
  console.log(`Done — ${ok} refreshed, ${failed} failed.`);
}

main().catch((err) => {
  console.error('Retry failed:', err);
  process.exitCode = 1;
});
