// Live AED -> LKR market rate from a free, keyless FX API.
// Cached briefly in memory so background loads don't hammer the API; the
// dashboard's Refresh button passes force=true to always get a fresh quote.

const FX_URL = 'https://open.er-api.com/v6/latest/AED';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

let cache = null; // { rate, asOf, fetchedAt }

export async function getAedToLkrRate({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(FX_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.LKR;
    if (!Number.isFinite(rate)) throw new Error('LKR rate missing from FX response');
    cache = {
      rate,
      asOf: data.time_last_update_utc || new Date().toISOString(),
      fetchedAt: Date.now(),
    };
    return cache;
  } finally {
    clearTimeout(timer);
  }
}
