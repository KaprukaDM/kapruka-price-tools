// Shared entry point for the price reconciliation, used by BOTH the CLI
// (src/compare/index.js) and the web server (/api/compare).
//
// Parameterised by partner (see config/partners.json). Fetching both full
// catalogues hits the live sites and takes ~10s, so results are cached in
// memory per partner. Pass { force: true } to refetch.

import { fetchKaprukaCatalog, fetchPartnerCatalog, parseKaprukaSource } from './sources.js';
import { matchCatalogs, summarize } from './matcher.js';
import { getPartner } from './partners.js';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const cache = new Map(); // partnerId -> { at: epochMs, payload }

function nowMs() {
  return new Date().getTime();
}

async function compute(partner, log) {
  // The Kapruka side can be a partner storefront or a brand/category listing.
  const src = parseKaprukaSource(partner.kaprukaUrl || partner.kaprukaSlug);
  if (!src) {
    throw new Error(`Partner "${partner.name}" has no valid Kapruka link configured.`);
  }
  const [kapruka, partnerCat] = await Promise.all([
    fetchKaprukaCatalog(src, { log }),
    fetchPartnerCatalog(partner.partnerSite, { log, platform: partner.platform || 'auto' }),
  ]);
  const result = matchCatalogs(kapruka, partnerCat.products);
  return {
    generatedAt: new Date().toISOString(),
    partner: {
      id: partner.id,
      name: partner.name,
      kaprukaSlug: src.type === 'partner' ? src.slug : null,
      kaprukaLink: src.link,
      kaprukaSourceType: src.type,
      partnerLabel: partner.partnerLabel || partner.partnerSite,
      partnerSite: partner.partnerSite,
      platform: partnerCat.platform,
    },
    catalogCounts: { kapruka: kapruka.length, partner: partnerCat.products.length },
    summary: summarize(result),
    ...result, // matched, onlyKapruka, onlyPartner
  };
}

/**
 * Run the reconciliation for a partner (or return the cached result).
 * @param {{ partnerId?: string, force?: boolean, log?: (m: string) => void }} [opts]
 */
export async function runComparison({ partnerId, force = false, log = () => {} } = {}) {
  const partner = await getPartner(partnerId);
  const hit = cache.get(partner.id);
  if (!force && hit && nowMs() - hit.at < CACHE_TTL_MS) {
    return { ...hit.payload, cached: true };
  }
  const payload = await compute(partner, log);
  cache.set(partner.id, { at: nowMs(), payload });
  return { ...payload, cached: false };
}
