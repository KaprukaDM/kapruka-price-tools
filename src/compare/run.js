import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchKaprukaCatalog, fetchPartnerCatalog, parseKaprukaSource } from "./sources.js";
import { matchCatalogs, summarize } from "./matcher.js";
import { getPartner } from "./partners.js";
import { hydrateComparisonResultFromMcp } from "./mcpPrices.js";

const CACHE_TTL_MS = Number(process.env.COMPARE_CACHE_TTL_MS || 30 * 60 * 1000);
const CACHE_DIR = path.resolve(
  process.cwd(),
  process.env.COMPARE_CACHE_DIR || "data/compare-cache"
);

const memoryCache = new Map();
const refreshJobs = new Map();

function nowMs() {
  return Date.now();
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

  const result = matchCatalogs(kapruka, partnerCat.products);

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

  // Normal page load: return fresh cache instantly.
  if (!force && fresh) {
    return {
      ...hit.payload,
      cached: true,
      stale: false,
      refreshing: refreshJobs.has(partner.id),
      cacheAgeMs: ageMs
    };
  }

  // If cache exists but user clicked refresh or cache is old:
  // return old data instantly and refresh in background.
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

  // First ever load: no cache exists, so we must wait once.
  const payload = await refreshCache(partner, log);

  return {
    ...payload,
    cached: false,
    stale: false,
    refreshing: false,
    cacheAgeMs: 0
  };
}