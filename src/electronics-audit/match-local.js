// Matches Kapruka's Electronics catalog against each competitor site's
// CACHED full catalogue (competitor_products, populated by crawl-catalogs.js)
// instead of live-searching every product. Much faster (no per-product HTTP
// round trips) and considers every product a site carries, not just what a
// search query's top ~10 results surface — the live-search audit only
// matched 474/3,418 products for exactly that reason.
//
// Uses the SAME exact-model-code matching logic as run-audit.js (overlap
// coefficient, not Jaccard, to handle Kapruka's verbose names vs competitors'
// terser listings; requires a shared model code, no fuzzy name-only path).
//
// Usage: node src/electronics-audit/match-local.js [--limit=N] [--sites=domain1,domain2]

import 'dotenv/config';
import { fetchKaprukaCatalog } from '../compare/sources.js';
import { index } from '../compare/matcher.js';
import { codesMatch, specsConflict } from '../compare/normalize.js';
import { CATALOG_ADAPTERS, fetchPriceFromPage } from './site-adapters.js';
import { getCompetitorProducts, upsertPriceAuditItem } from '../db.js';

const CATEGORY = 'Electronics';
const KAPRUKA_SOURCE = { type: 'catalogue', buy: 'electronics', subcat: null };

const OVERLAP_THRESHOLD = 0.6;
const CODE_MATCH_MIN_OVERLAP = 0.15;
const MIN_INTERSECTION = 2;

function overlapCoefficient(a, b) {
  if (a.size === 0 || b.size === 0) return { overlap: 0, intersection: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return { overlap: inter / Math.min(a.size, b.size), intersection: inter };
}

function sharedCodeCount(aCodes, bCodes) {
  let n = 0;
  for (const a of aCodes) for (const b of bCodes) if (codesMatch(a, b)) { n++; break; }
  return n;
}

function versionNumbers(name) {
  return new Set((String(name || '').match(/\b\d{1,2}\b/g) || []));
}

// Identical acceptance criteria to run-audit.js's scoreCandidate — see that
// file's comment for why (exact-model-only, overlap coefficient not Jaccard).
function scoreCandidate(k, c) {
  const codes = sharedCodeCount(k._codes, c._codes);
  if (codes < 1) return null;
  const { overlap, intersection } = overlapCoefficient(k._tokens, c._tokens);
  if (overlap < CODE_MATCH_MIN_OVERLAP || intersection < MIN_INTERSECTION || specsConflict(k._specs, c._specs)) {
    return null;
  }
  const kVersions = versionNumbers(k.name);
  const cVersions = versionNumbers(c.name);
  const versionAgrees = [...kVersions].some((v) => cVersions.has(v));
  const versionBonus = kVersions.size && cVersions.size ? (versionAgrees ? 0.05 : -0.5) : 0;
  return { value: 1 + overlap + versionBonus, codes, overlap };
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;
  const sitesArg = process.argv.find((a) => a.startsWith('--sites='));
  const onlySites = sitesArg ? new Set(sitesArg.split('=')[1].split(',')) : null;
  const sites = onlySites ? CATALOG_ADAPTERS.filter((s) => onlySites.has(s.domain)) : CATALOG_ADAPTERS;

  console.log(`Fetching Kapruka ${CATEGORY} catalog...`);
  const kaprukaProducts = await fetchKaprukaCatalog(KAPRUKA_SOURCE, { log: (m) => console.log(`  ${m}`) });
  const list = limit ? kaprukaProducts.slice(0, limit) : kaprukaProducts;
  console.log(`${kaprukaProducts.length} Kapruka products${limit ? ` — matching first ${list.length}` : ''}.`);

  console.log(`Loading cached catalogues for ${sites.length} sites...`);
  const siteCatalogs = [];
  for (const site of sites) {
    const rows = await getCompetitorProducts(site.domain);
    if (rows.length === 0) {
      console.log(`  ${site.domain}: 0 cached products — run crawl-catalogs.js first. Skipping.`);
      continue;
    }
    const indexed = index(
      rows.map((r) => ({ name: r.product_name, url: r.product_url, priceLKR: r.price_lkr })),
      false,
    );
    siteCatalogs.push({ domain: site.domain, name: site.name, products: indexed });
    console.log(`  ${site.domain}: ${rows.length} cached products`);
  }

  if (siteCatalogs.length === 0) {
    console.log('No cached catalogues available. Run crawl-catalogs.js first.');
    return;
  }

  let matchCount = 0;
  let done = 0;
  const startedAt = Date.now();

  for (const kProduct of list) {
    done++;
    if (!kProduct.name) continue;
    const [kIndexed] = index([{ name: kProduct.name, url: kProduct.url }], false);

    for (const site of siteCatalogs) {
      let best = null;
      for (const c of site.products) {
        const sc = scoreCandidate(kIndexed, c);
        if (sc && (!best || sc.value > best.sc.value)) best = { c, sc };
      }
      if (!best) continue;

      let matchedPriceLKR = best.c.priceLKR;
      if (matchedPriceLKR == null) {
        matchedPriceLKR = await fetchPriceFromPage(best.c.url).catch(() => null);
      }
      const diffLkr = matchedPriceLKR != null && kProduct.price != null ? kProduct.price - matchedPriceLKR : null;
      const diffPct = diffLkr != null && matchedPriceLKR ? (diffLkr / matchedPriceLKR) * 100 : null;

      matchCount++;
      if (process.env.AUDIT_VERBOSE) {
        console.log(
          `  match: "${kProduct.name}" -> [${site.domain}] "${best.c.name}" Rs.${matchedPriceLKR ?? '?'} ` +
            `overlap=${best.sc.overlap.toFixed(2)} codes=${best.sc.codes}`,
        );
      }

      try {
        await upsertPriceAuditItem({
          category: CATEGORY,
          kaprukaUrl: kProduct.url,
          kaprukaName: kProduct.name,
          kaprukaPriceLkr: kProduct.price ?? null,
          siteDomain: site.domain,
          siteName: site.name,
          matchedUrl: best.c.url,
          matchedName: best.c.name,
          matchedPriceLkr: matchedPriceLKR,
          matchConfidence: 'high',
          sharedCodes: best.sc.codes,
          nameSimilarity: Math.round(best.sc.overlap * 100),
          diffLkr,
          diffPct,
        });
      } catch (err) {
        console.warn(`  ! DB write failed for ${kProduct.name} / ${site.domain}: ${err.message}`);
      }
    }

    if (done % 100 === 0 || done === list.length) {
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  [${done}/${list.length}] (${elapsedS}s) ${matchCount} matches so far`);
    }
  }

  console.log(`\nLocal match complete: ${matchCount} matches across ${list.length} products x ${siteCatalogs.length} sites.`);
}

main().catch((err) => {
  console.error('Local match failed:', err);
  process.exit(1);
});
