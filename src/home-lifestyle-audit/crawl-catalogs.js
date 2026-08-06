// Crawls each NEW competitor site's FULL home & lifestyle catalogue and
// caches it in Supabase (competitor_products). Sites already crawled for
// Electronics/Cosmetics that also carry home/lifestyle products (wasi.lk,
// dinapalagroup.lk, celltronics.lk) are NOT re-crawled here — match-local.js
// reuses their existing cached data directly.
//
// Usage: node src/home-lifestyle-audit/crawl-catalogs.js [--only=domain1,domain2]

import 'dotenv/config';
import { CATALOG_ADAPTERS } from './site-adapters.js';
import { upsertCompetitorProducts } from '../db.js';

async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.split('=')[1].split(',')) : null;
  const sites = only ? CATALOG_ADAPTERS.filter((s) => only.has(s.domain)) : CATALOG_ADAPTERS;

  console.log(`Crawling ${sites.length} site catalogues...`);
  let totalProducts = 0;

  for (const site of sites) {
    const startedAt = Date.now();
    let products = [];
    try {
      products = await site.fetchCatalog();
    } catch (err) {
      console.error(`  ! ${site.domain} crawl failed entirely: ${err.message}`);
      continue;
    }
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  ${site.domain}: ${products.length} products (${elapsedS}s)`);
    if (products.length === 0) continue;

    try {
      await upsertCompetitorProducts(
        site.domain,
        products.map((p) => ({ ...p, siteName: site.name })),
        'Home & Lifestyle',
      );
      totalProducts += products.length;
    } catch (err) {
      console.error(`  ! ${site.domain}: failed to save to Supabase: ${err.message}`);
    }
  }

  console.log(`\nCrawl complete: ${totalProducts} total products cached across ${sites.length} sites.`);
}

main().catch((err) => {
  console.error('Catalog crawl failed:', err);
  process.exit(1);
});
