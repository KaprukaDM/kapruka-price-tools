// Persists Kapruka SKU -> matching competitor-site URL pairings per country,
// via the shared database (src/db.js) — NOT a local file, since Render's free
// tier wipes the filesystem on every redeploy. Once a pairing is confirmed
// (auto-matched or manually set), it's cached here so future refreshes fetch
// that exact competitor product page directly instead of re-crawling/
// re-matching the competitor's catalog.

import { getIntlGiftPairings, setIntlGiftPairing } from '../db.js';

export async function loadPairings(country) {
  return getIntlGiftPairings(country);
}

export async function setPairing(country, sku, fnpUrl, matchSource = 'manual', matchConfidence = null) {
  await setIntlGiftPairing(country, sku, fnpUrl, matchSource, matchConfidence);
  return loadPairings(country);
}
