// Converts a foreign-currency amount to LKR. Kapruka geo-detects the
// connecting IP and serves the price in whatever currency it thinks that
// country uses (USD, AED, GBP, ... — not just one), so this isn't a
// single-currency problem; any non-LKR currency needs handling.
//
// Same free, keyless FX API as src/uae-compare/fx.js, generalized to an
// arbitrary base currency and cached per-currency in memory.

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const cache = new Map(); // currency -> { rate, fetchedAt }

// Last-resort rates if the live FX API is unreachable — approximate, just
// enough to avoid showing a foreign-currency number as if it were rupees.
const FALLBACK_RATES = { USD: 270, AED: 74, GBP: 345, EUR: 295, AUD: 175, CAD: 195 };

export async function convertToLkr(amount, currency) {
  if (!Number.isFinite(amount)) return null;
  const cur = String(currency || '').toUpperCase();
  if (!cur || cur === 'LKR') return Math.round(amount);

  const cached = cache.get(cur);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return Math.round(amount * cached.rate);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(cur)}`, {
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.LKR;
    if (!Number.isFinite(rate)) throw new Error('LKR rate missing from FX response');
    cache.set(cur, { rate, fetchedAt: Date.now() });
    return Math.round(amount * rate);
  } catch {
    const fallback = FALLBACK_RATES[cur];
    return fallback ? Math.round(amount * fallback) : null;
  } finally {
    clearTimeout(timer);
  }
}
