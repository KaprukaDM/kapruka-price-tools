// Local product-price audit: for every Kapruka Electronics product, search
// each of the 25 confirmed competitor sites' own search endpoints (see
// site-adapters.js / playwright-adapters.js), keep the best name/model-code
// match, and upsert the result to Supabase (price_audit_items).
//
// Run from the local machine, not the VPS — Kapruka geo-converts prices for
// non-Sri-Lankan IPs (see SCRAPER-SETUP.md), and this machine is the
// confirmed-good host, same as the existing partner-comparison scraper.
//
// Usage: node src/electronics-audit/run-audit.js [--limit=N] [--concurrency=N]

import 'dotenv/config';
import { fetchKaprukaCatalog } from '../compare/sources.js';
import { index } from '../compare/matcher.js';
import { tokenize, codesMatch, specsConflict } from '../compare/normalize.js';
import { SITE_ADAPTERS, fetchPriceFromPage } from './site-adapters.js';
import { PLAYWRIGHT_SITE_ADAPTERS, closeSharedBrowser } from './playwright-adapters.js';
import { upsertPriceAuditItem } from '../db.js';

// otc.lk and directdealz.lk (Playwright, behind Cloudflare) are excluded by
// default: a product isn't "done" until every site responds, so ANY single
// slow/stuck site — and Cloudflare challenges are exactly that, inherently
// flaky under repeated automated hits — taxes every one of ~1,500 products'
// wall-clock time, not just its own. Pass --include-playwright to opt in.
const includePlaywright = process.argv.includes('--include-playwright');
const baseAdapters = includePlaywright ? [...SITE_ADAPTERS, ...PLAYWRIGHT_SITE_ADAPTERS] : SITE_ADAPTERS;

// Sites confirmed unreachable right now (verified with a direct curl outside
// this codebase, not an adapter bug) — excluded per-run rather than removed
// from site-adapters.js, since this is about today's outage, not a permanent
// gap. Re-check and drop from here whenever a fresh run starts timing out
// again on a "should be fine" site.
const DOWN_TODAY = new Set(['greenware.lk']);
const ALL_ADAPTERS = baseAdapters.filter((s) => !DOWN_TODAY.has(s.domain));
const CATEGORY = 'Electronics';
const KAPRUKA_SOURCE = { type: 'catalogue', buy: 'electronics', subcat: null };
const SITE_CONCURRENCY = 5; // sites queried in parallel per product — high product concurrency x
                             // this multiplies into simultaneous connection counts that appear to
                             // cause connection contention (a wave of unrelated sites timing out
                             // together, not any single site being genuinely down)

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

// These site search boxes need a near-literal phrase match, not fuzzy/token
// search — the FULL Kapruka name (verbose, SEO-style: "Jbl Xtreme 4 Portable
// Bluetooth Speaker Powerful Sound Deep Bass") almost never appears verbatim
// on a competitor's own listing, so it returns zero results almost
// everywhere even when the product genuinely IS carried. A short 2-token
// query ("jbl xtreme") finds it instantly. So: query short, match strict —
// the shortened string only widens the candidate pool; final matching below
// still uses the FULL name via matcher.js's model-code+jaccard scoring, so a
// broader pool doesn't risk false positives.
function buildSearchQuery(name) {
  const tokens = [...tokenize(name)].slice(0, 2);
  return tokens.join(' ') || String(name || '').trim();
}

// matcher.js's score() uses Jaccard (intersection / union), tuned for
// comparing two catalogues written in a similarly terse style. Here one side
// (Kapruka) is consistently much wordier/SEO-heavier than the other
// (a competitor's own short listing title), so Jaccard's denominator gets
// inflated by Kapruka-only marketing tokens and true matches score too low
// (e.g. "JBL Xtreme 4 - Blue" vs Kapruka's "Jbl Xtreme 4 Portable Bluetooth
// Speaker Powerful Sound Deep Bass" — real match, Jaccard ~0.2). Overlap
// coefficient (intersection / min-size) isn't penalized by the longer side's
// extra tokens, so it's the right measure for this asymmetric case — with a
// minimum absolute intersection count as a guard against short, generic
// candidates trivially "containing" themselves in anything.
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

// tokenize() drops 1-2 digit tokens as noise (correctly, in general — but a
// bare "4"/"5" is often a product GENERATION number, e.g. "JBL Xtreme 4" vs
// "JBL Xtreme 5" tokenize identically once that digit is gone). A small
// ranking tiebreaker, not a rejection gate, so it only resolves ties between
// otherwise-equal candidates rather than rejecting a real match that simply
// has no version number.
function versionNumbers(name) {
  return new Set((String(name || '').match(/\b\d{1,2}\b/g) || []));
}

function scoreCandidate(k, c) {
  const codes = sharedCodeCount(k._codes, c._codes);
  const { overlap, intersection } = overlapCoefficient(k._tokens, c._tokens);
  const codeMatch = codes >= 1 && overlap >= CODE_MATCH_MIN_OVERLAP;
  const nameMatch = overlap >= OVERLAP_THRESHOLD && intersection >= MIN_INTERSECTION && !specsConflict(k._specs, c._specs);
  if (!codeMatch && !nameMatch) return null;
  const kVersions = versionNumbers(k.name);
  const cVersions = versionNumbers(c.name);
  const versionAgrees = [...kVersions].some((v) => cVersions.has(v));
  const versionBonus = kVersions.size && cVersions.size ? (versionAgrees ? 0.05 : -0.5) : 0;
  return { value: (codes >= 1 ? 1 : 0) + overlap + versionBonus, codes, overlap };
}

// A product isn't "done" until every site responds, so one consistently slow
// or Cloudflare-stuck site (each adapter has its own internal fetch timeout,
// but a multi-step CSRF flow can add up) taxes EVERY product in the run, not
// just the ones where it matters. Hard-cap each site's search regardless of
// what it's internally doing.
const SITE_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

async function auditProductOnSite(kIndexed, kProduct, site) {
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

  if (process.env.AUDIT_VERBOSE) {
    console.log(
      `  match: "${kProduct.name}" (Rs.${kProduct.price ?? '?'}) -> [${site.domain}] ` +
        `"${best.c.name}" (Rs.${matchedPriceLKR ?? '?'}) overlap=${best.sc.overlap.toFixed(2)} codes=${best.sc.codes}`,
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
      matchConfidence: best.sc.codes >= 1 ? 'high' : 'medium',
      sharedCodes: best.sc.codes,
      nameSimilarity: Math.round(best.sc.overlap * 100),
      diffLkr,
      diffPct,
    });
  } catch (err) {
    // A single failed write (transient Supabase hiccup, or the table not
    // existing yet) shouldn't crash a multi-hour audit run.
    console.warn(`  ! DB write failed for ${kProduct.name} / ${site.domain}: ${err.message}`);
  }
}

async function auditProduct(kProduct) {
  if (!kProduct.name) return;
  const [kIndexed] = index([{ name: kProduct.name, url: kProduct.url }], false);
  await mapWithConcurrency(ALL_ADAPTERS, SITE_CONCURRENCY, (site) => auditProductOnSite(kIndexed, kProduct, site));
}

async function main() {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null;
  const concurrencyArg = process.argv.find((a) => a.startsWith('--concurrency='));
  const productConcurrency = concurrencyArg ? Number(concurrencyArg.split('=')[1]) : 3;

  console.log(`Fetching Kapruka ${CATEGORY} catalog...`);
  const products = await fetchKaprukaCatalog(KAPRUKA_SOURCE, { log: (m) => console.log(`  ${m}`) });
  const list = limit ? products.slice(0, limit) : products;
  console.log(
    `${products.length} products in catalog${limit ? ` — auditing first ${list.length}` : ''}. ` +
      `Checking against ${ALL_ADAPTERS.length} sites (product concurrency ${productConcurrency}).`,
  );

  let done = 0;
  const startedAt = Date.now();
  await mapWithConcurrency(list, productConcurrency, async (p) => {
    await auditProduct(p);
    done++;
    if (done % 10 === 0 || done === list.length) {
      const elapsedS = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  [${done}/${list.length}] (${elapsedS}s) ${p.name}`);
    }
  });

  await closeSharedBrowser();
  console.log(`Audit complete: ${list.length} products checked against ${ALL_ADAPTERS.length} sites.`);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
