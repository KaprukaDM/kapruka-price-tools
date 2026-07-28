// Express API for the International Gifting Price Checker's LOCAL/dev usage —
// mounted either by the standalone server (src/uae-compare/server.js,
// `npm run uae-compare`) or embedded into the main Price Tools hub
// (src/server.js) at /api/uae-compare/*.
//
// The production dashboard (GitHub Pages, public/uae-compare/index.html)
// does NOT call this — it reads the latest snapshot straight from Supabase
// and triggers refreshes/pairing edits via GitHub Actions instead, since a
// static page has no server to call. This router exists for local
// development and as a fallback when running your own server. See
// engine.js for the actual comparison logic (shared by both paths) and
// scripts/refresh-intl-gifts.js / scripts/set-intl-gift-pairing.js for the
// GitHub Actions entry points.

import express from 'express';

import { runComparison } from './engine.js';
import { loadPairings, setPairing } from './pairings-store.js';
import { getCountry } from './countries.js';

// Returns an Express Router with the /api/uae-compare/* routes. The caller is
// responsible for express.json() (so it isn't applied twice when embedded in
// a host app that already parses JSON globally).
export function uaeCompareApiRouter() {
  const router = express.Router();

  // Full refresh: re-scrape Kapruka's country catalog, fetch every paired
  // competitor product directly, crawl+match anything still unpaired, fetch
  // a fresh FX rate, and save the result as the latest snapshot.
  router.post('/api/uae-compare/refresh', async (req, res) => {
    const countryCode = req.query.country || 'UAE';
    try {
      res.json(await runComparison(countryCode, { forceFx: true }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/uae-compare/pairings', async (req, res) => {
    const countryCode = req.query.country || 'UAE';
    res.json(await loadPairings(countryCode));
  });

  router.post('/api/uae-compare/pairings', async (req, res) => {
    const countryCode = req.query.country || 'UAE';
    const { sku, fnpUrl } = req.body || {};
    if (!sku) return res.status(400).json({ error: 'sku is required' });
    let country;
    try {
      country = getCountry(countryCode);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (fnpUrl && !country.competitorUrlPattern.test(fnpUrl)) {
      return res.status(400).json({ error: `fnpUrl must be a ${country.competitorName} product link` });
    }
    const pairings = await setPairing(countryCode, sku, fnpUrl || null, 'manual', null);
    res.json(pairings);
  });

  return router;
}
