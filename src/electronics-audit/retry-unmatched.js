// Retries currently-unmatched Kapruka Electronics products via LIVE SEARCH
// against sites whose full-catalogue crawl is category-ENUMERATION-based
// (nanotek.lk, mcentre.lk, cameralk.com, bigdeals.lk, singhagiri.lk) rather
// than a true "browse everything" endpoint — those crawls only cover the
// hardcoded/guessed category list in site-adapters.js, so a product in a
// category we didn't enumerate is invisible to match-local.js no matter how
// many times it runs. Live search hits the site's own search box instead,
// which isn't limited by our category list.
//
// Only touches products with NO existing match — never overwrites or
// deletes a match-local.js result, only ADDS ones found here.
//
// Usage: node src/electronics-audit/retry-unmatched.js [--limit=N]

import 'dotenv/config';
import { fetchKaprukaCatalog } from '../compare/sources.js';
import { index } from '../compare/matcher.js';
import { scoreCandidate } from '../compare/audit-scoring.js';
import { tokenize } from '../compare/normalize.js';
import { SITE_ADAPTERS, fetchPriceFromPage } from './site-adapters.js';
import { getPriceAuditItems, upsertPriceAuditItem } from '../db.js';

const CATEGORY = 'Electronics';
const KAPRUKA_SOURCE = { type: 'catalogue', buy: 'electronics', subcat: null };
const ENUMERATION_BASED_DOMAINS = new Set(['nanotek.lk', 'mcentre.lk', 'cameralk.com', 'bigdeals.lk', 'singhagiri.lk']);
const SITE_TIMEOUT_MS = 15000;
const PRODUCT_CONCURRENCY = 3;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Same as run-audit.js's buildSearchQuery — these search boxes need a short
// near-literal phrase, not Kapruka's full verbose SEO-style name.
function buildSearchQuery(name) {
  const tokens = [...tokenize(name)].slice(0, 2);
  return tokens.join(' ') || String(name || '').trim();
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function retryProductOnSite(kIndexed, kProduct, site) {
  let candidates = [];
  try {
    candidates = await withTimeout(site.search(buildSearchQuery(kProduct.name)), SITE_TIMEOUT_MS);
  } catch (err) {
    console.warn(`  ! ${site.domain}: ${err.message}`);
    return;
  }
  if (!candidates.length) return;

  const indexedCandidates = index(
    candidates.map((c) => ({ name: c.name, url: c.url, priceLKR: c.priceLKR })),
    false,
  );
  let best = null;
  for (const c of indexedCandidates) {
    const sc = scoreCandidate(kIndexed, c);
    if (sc && (!best || sc.value > best.sc.value)) best = { c, sc };
  }
  if (!best) return;

  let matchedPriceLKR = best.c.priceLKR;
  if (matchedPriceLKR == null) {
    matchedPriceLKR = await fetchPriceFromPage(best.c.url).catch(() => null);
  }
  const diffLkr = matchedPriceLKR != null && kProduct.price != null ? kProduct.price - matchedPriceLKR : null;
  const diffPct = diffLkr != null && matchedPriceLKR ? (diffLkr / matchedPriceLKR) * 100 : null;

  console.log(
    `  found via retry: "${kProduct.name}" -> [${site.domain}] "${best.c.name}" ` +
      `Rs.${matchedPriceLKR ?? '?'} overlap=${best.sc.overlap.toFixed(2)} codes=${best.sc.codes}`,
  );

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
      matchConfidence: best.sc.codes >= 1 ? 'high' : 'medium',
      sharedCodes: best.sc.codes,
      nameSimilarity: Math.round(best.sc.overlap * 100),
      diffLkr,
      diffPct,
    });
    return true;
  } catch (err) {
    console.warn(`  ! DB write failed for ${kProduct.name} / ${site.domain}: ${err.message}`);
    return false;
  }
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

  const retrySites = SITE_ADAPTERS.filter((s) => ENUMERATION_BASED_DOMAINS.has(s.domain));
  console.log(`Retrying unmatched products against ${retrySites.length} sites: ${retrySites.map((s) => s.domain).join(', ')}`);

  console.log(`Fetching Kapruka ${CATEGORY} catalog...`);
  const catalog = await fetchKaprukaCatalog(KAPRUKA_SOURCE, { log: (m) => console.log(`  ${m}`) });

  console.log('Loading currently-matched products...');
  const existing = await getPriceAuditItems({ category: CATEGORY, limit: 10000 });
  const matchedUrls = new Set(existing.map((i) => i.kapruka_url));

  const unmatched = catalog.filter((p) => !matchedUrls.has(p.url));
  const list = limit ? unmatched.slice(0, limit) : unmatched;
  console.log(`${catalog.length} total, ${unmatched.length} currently unmatched${limit ? ` — retrying first ${list.length}` : ''}.`);

  let foundCount = 0;
  let done = 0;
  const startedAt = Date.now();
  await mapWithConcurrency(list, PRODUCT_CONCURRENCY, async (kProduct) => {
    if (!kProduct.name) return;
    const [kIndexed] = index([{ name: kProduct.name, url: kProduct.url }], false);
    const results = await mapWithConcurrency(retrySites, retrySites.length, (site) =>
      retryProductOnSite(kIndexed, kProduct, site),
    );
    if (results.some(Boolean)) foundCount++;
    done++;
    if (done % 50 === 0 || done === list.length) {
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  [${done}/${list.length}] (${elapsedS}s) ${foundCount} new matches found so far`);
    }
  });

  console.log(`\nRetry complete: ${foundCount} previously-unmatched products found a match across ${retrySites.length} sites.`);
}

main().catch((err) => {
  console.error('Retry failed:', err);
  process.exit(1);
});
