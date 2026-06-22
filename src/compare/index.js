// Price reconciliation runner (CLI).
//
//   node src/compare/index.js [partnerId]
//
// Fetches the full catalogue from our Kapruka partner page and from the
// partner's own site, matches products across the two, and writes a report
// (CSV + HTML) into ./out. Answers four questions:
//   1. Which products are on both sites, and is the price the same?
//   2. Which are overpriced on Kapruka vs. the partner site?
//   3. Which are listed on Kapruka but not on the partner site?
//   4. Which are on the partner site but not listed on Kapruka?

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runComparison } from './run.js';
import { writeReports } from './report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', '..', 'out');
const lkr = (v) => (v == null ? '—' : `Rs.${Number(v).toLocaleString('en-LK')}`);

async function main() {
  const log = (m) => console.log(m);
  const partnerId = process.argv[2]; // optional; defaults to first configured partner

  console.log('Fetching catalogues...');
  const data = await runComparison({ partnerId, force: true, log });
  const result = {
    matched: data.matched,
    onlyKapruka: data.onlyKapruka,
    onlyPartner: data.onlyPartner,
  };
  const pName = data.partner.name;
  console.log(`\nPartner:  ${pName} (${data.partner.partnerLabel}, ${data.partner.platform})`);
  console.log(`Kapruka:  ${data.catalogCounts.kapruka} products`);
  console.log(`${pName}: ${data.catalogCounts.partner} products\n`);

  const generatedAt = data.generatedAt.replace('T', ' ').slice(0, 16) + ' UTC';
  const s = await writeReports(result, OUT_DIR, { generatedAt, partner: data.partner });

  console.log('================ SUMMARY ================');
  console.log(`Matched on both sites     : ${s.matched}`);
  console.log(`  · Same price            : ${s.same}`);
  console.log(`  · Kapruka OVERPRICED    : ${s.kaprukaHigher}`);
  console.log(`  · Kapruka cheaper       : ${s.kaprukaLower}`);
  console.log(`  · Price missing         : ${s.priceMissing}`);
  console.log(`Only on Kapruka (here)    : ${s.onlyKapruka}`);
  console.log(`Only on ${pName} (there)  : ${s.onlyPartner}`);
  console.log('=========================================\n');

  const over = result.matched
    .filter((m) => m.verdict === 'kapruka_higher')
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 15);
  if (over.length) {
    console.log(`Top items overpriced on Kapruka (Kapruka − ${pName}):`);
    for (const m of over) {
      console.log(
        `  +${lkr(m.diff)} (${m.pct.toFixed(0)}%)  ${m.name.slice(0, 60)}  [${lkr(m.kaprukaPrice)} vs ${lkr(m.partnerPrice)}]`,
      );
    }
    console.log('');
  }
  console.log(`Reports written to: ${OUT_DIR}`);
  console.log('  · report.html  (open in a browser)');
  console.log('  · matched.csv / only_on_kapruka.csv / only_on_partner.csv');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
