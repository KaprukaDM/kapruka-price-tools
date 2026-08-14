import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchKaprukaCatalog, fetchPartnerCatalog, fetchKaprukaProduct, parseKaprukaSource } from "./sources.js";
import { matchCatalogs, summarize } from "./matcher.js";
import { getPartner } from "./partners.js";
import { hydrateComparisonResultFromMcp } from "./mcpPrices.js";

const CACHE_TTL_MS = Number(process.env.COMPARE_CACHE_TTL_MS || 30 * 60 * 1000);
const CACHE_DIR = path.resolve(
  process.cwd(),
  process.env.COMPARE_CACHE_DIR || "data/compare-cache"
);
// The Kapruka *catalogue/storefront listing* page's JSON-LD reports every
// product as in stock regardless of reality (confirmed against live data —
// see the Out of Stock dashboard's original limitation note); only a
// product's own page carries accurate, real-time availability. So after
// matching, re-check each matched pair's Kapruka stock status against its
// own product page rather than trusting the catalogue scrape's inStock flag.
// One extra request per *matched* product only (not the full catalogue),
// throttled to stay under Kapruka's rate limit. Off switch for emergencies.
const STOCK_HYDRATE_DELAY_MS = Number(process.env.KAPRUKA_STOCK_DELAY_MS || 350);
const DISABLE_STOCK_HYDRATE = process.env.DISABLE_KAPRUKA_STOCK_HYDRATE === "1";

const memoryCache = new Map();
const refreshJobs = new Map();

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hydrateKaprukaStock(matched, log) {
  if (DISABLE_STOCK_HYDRATE || !matched.length) return { checked: 0, flippedOos: 0 };
  let checked = 0;
  let flippedOos = 0;
  for (const row of matched) {
    if (checked > 0) await sleep(STOCK_HYDRATE_DELAY_MS);
    checked++;
    try {
      const product = await fetchKaprukaProduct(row.kaprukaUrl);
      const realInStock = product?.inStock !== false;
      if (row.kaprukaInStock && !realInStock) flippedOos++;
      row.kaprukaInStock = realInStock;
    } catch (err) {
      // Leave the catalogue-scrape default (in stock) rather than failing
      // the whole comparison run over one product's fetch error.
      log(`Stock check failed for "${row.name}": ${err.message}`);
    }
  }
  return { checked, flippedOos };
}

function cacheFile(partnerId) {
  return path.join(CACHE_DIR, `${partnerId}.json`);
}

async function readDiskCache(partnerId) {
  try {
    const raw = await readFile(cacheFile(partnerId), "utf8");
    const payload = JSON.parse(raw);
    const at = Date.parse(payload.generatedAt) || nowMs();

    const hit = { at, payload };
    memoryCache.set(partnerId, hit);
    return hit;
  } catch {
    return null;
  }
}

async function writeDiskCache(partnerId, payload) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile(partnerId), JSON.stringify(payload, null, 2), "utf8");
}

async function compute(partner, log) {
  const src = parseKaprukaSource(partner.kaprukaUrl || partner.kaprukaSlug);

  if (!src) {
    throw new Error(`Partner "${partner.name}" has no valid Kapruka link configured.`);
  }

  const [kapruka, partnerCat] = await Promise.all([
    fetchKaprukaCatalog(src, { log }),
    fetchPartnerCatalog(partner.partnerSite, {
      log,
      platform: partner.platform || "auto",
      viaBrowser: partner.viaBrowser || false
    })
  ]);

  const result = matchCatalogs(kapruka, partnerCat.products, partner.name);

  const stock = await hydrateKaprukaStock(result.matched, log);
  if (stock.checked) {
    log(`  Kapruka stock re-checked: ${stock.checked} matched product(s), ${stock.flippedOos} corrected to out-of-stock`);
  }

  const mcp = await hydrateComparisonResultFromMcp(result, { log });

  return {
    generatedAt: new Date().toISOString(),
    partner: {
      id: partner.id,
      name: partner.name,
      kaprukaSlug: src.type === "partner" ? src.slug : null,
      kaprukaLink: src.link,
      kaprukaSourceType: src.type,
      partnerLabel: partner.partnerLabel || partner.partnerSite,
      partnerSite: partner.partnerSite,
      platform: partnerCat.platform
    },
    catalogCounts: {
      kapruka: kapruka.length,
      partner: partnerCat.products.length
    },
    mcp,
    summary: result.summary || summarize(result),
    ...result
  };
}

async function refreshCache(partner, log) {
  if (refreshJobs.has(partner.id)) {
    return refreshJobs.get(partner.id);
  }

  const job = compute(partner, log)
    .then(async (payload) => {
      const hit = { at: nowMs(), payload };
      memoryCache.set(partner.id, hit);
      await writeDiskCache(partner.id, payload);
      log(`✓ Background cache updated for ${partner.name}`);
      return payload;
    })
    .catch((err) => {
      log(`✗ Background cache failed for ${partner.name}: ${err.message}`);
      throw err;
    })
    .finally(() => {
      refreshJobs.delete(partner.id);
    });

  refreshJobs.set(partner.id, job);
  return job;
}

export async function runComparison({ partnerId, force = false, log = () => {} } = {}) {
  const partner = await getPartner(partnerId);

  let hit = memoryCache.get(partner.id);

  if (!hit) {
    hit = await readDiskCache(partner.id);
  }

  const ageMs = hit ? nowMs() - hit.at : Infinity;
  const fresh = hit && ageMs < CACHE_TTL_MS;

  // Normal page load, not forced: return fresh cache instantly.
  if (!force && fresh) {
    return {
      ...hit.payload,
      cached: true,
      stale: false,
      refreshing: refreshJobs.has(partner.id),
      cacheAgeMs: ageMs
    };
  }

  // Explicitly forced (the scheduled job, or a background scrape right after
  // adding a partner) must always wait for a genuinely fresh result — never
  // silently hand back stale data just because a disk-cache entry happens to
  // exist. This matters a lot for callers like refresh-all-partners.js: they
  // only persist to Supabase when `cached` comes back false, so returning
  // stale-but-unlabelled-as-such here would make `force: true` silently do
  // nothing (no rescrape, no save) forever once one cache entry exists.
  if (force) {
    const payload = await refreshCache(partner, log);
    return { ...payload, cached: false, stale: false, refreshing: false, cacheAgeMs: 0 };
  }

  // Not forced, but no fresh cache: if we have *some* cache (just stale),
  // serve it immediately and refresh in the background (stale-while-
  // revalidate) so an on-demand page view doesn't have to block.
  if (hit) {
    refreshCache(partner, log).catch(() => {});

    return {
      ...hit.payload,
      cached: true,
      stale: true,
      refreshing: true,
      cacheAgeMs: ageMs
    };
  }

  // First ever load: no cache exists at all, so we must wait once.
  const payload = await refreshCache(partner, log);

  return {
    ...payload,
    cached: false,
    stale: false,
    refreshing: false,
    cacheAgeMs: 0
  };
}