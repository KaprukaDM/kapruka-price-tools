import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadCategories, runMatch, addCategorySites, OTHER_CATEGORY } from './pipeline.js';
import { searchDatabase } from './checker/db-search.js';
import { searchDaraz } from './daraz.js';
import { runComparison } from './compare/run.js';
import { recommendPrice } from './price-insight.js';
import { listPartners, addPartner, siteLabel, getPartner, requestRefresh } from './compare/partners.js';
import {
  probeKaprukaSource,
  detectPartnerPlatform,
  parseKaprukaSource,
  fetchKaprukaProduct,
  findKaprukaProduct,
} from './compare/sources.js';
import {
  savePriceCheck,
  saveComparisonRun,
  recentPriceChecks,
  recentComparisonRuns,
  getComparisonRun,
  storageKind,
  listUnsupportedPartners,
  addUnsupportedPartner,
  listRemovedProducts,
  addRemovedProduct,
  deleteRemovedProduct,
  removedUrlSet,
  listDiscoveredSites,
  setDiscoveredSiteStatus,
  countBulkRefreshesSince,
  logBulkRefreshRequest,
} from './db.js';
import { summarize } from './compare/matcher.js';
import {
  exportPriceChecksCsv,
  exportComparisonCsv,
  exportProductsCsv,
  exportOverpricedCsv,
  overpricedReport,
  allProductsOverpricedReport,
  exportAllProductsOverpricedCsv,
  stockMismatchReport,
  exportStockMismatchCsv,
  priceChangesReport,
  exportPriceChangesCsv,
  productRows,
  invalidateReportCache,
} from './export.js';
import { uaeCompareApiRouter } from './uae-compare/routes.js';
import { sendWhatsAppMessage, whatsappConfigured } from './notify/whatsapp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));
// International (FNP.ae vs Kapruka UAE) price dashboard — static page already
// served above from public/uae-compare/; this adds its /api/uae-compare/* routes.
app.use(uaeCompareApiRouter());

// Categories + their sites (drives the dropdown).
app.get('/api/categories', async (_req, res) => {
  try {
    const categories = await loadCategories();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a category (or add competitor sites to an existing one) for the Price
// Checker. Body: { name, links: string[] } — up to 5 competitor site links.
app.post('/api/categories', async (req, res) => {
  const { name, links } = req.body || {};
  const categoryName = (name || '').trim();
  const cleanLinks = (Array.isArray(links) ? links : []).map((l) => String(l || '').trim()).filter(Boolean);
  if (!categoryName || cleanLinks.length === 0) {
    return res.status(400).json({ error: 'A category name and at least one competitor link are required.' });
  }
  if (cleanLinks.length > 5) {
    return res.status(400).json({ error: 'Up to 5 competitor links per category.' });
  }
  try {
    const result = await addCategorySites(categoryName, cleanLinks);
    if (result.added.length === 0) {
      return res.status(400).json({ error: 'Those links did not resolve to any new sites (invalid URL or already added).' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Discovered-sites review queue ----------------------------------------
// Domains the Price Checker's web-search discovery step (serp.js's
// getShoppingCandidates(), logged from pipeline.js) keeps turning up that
// aren't a curated category site yet. A human reviews and approves/rejects
// each one here rather than it happening automatically — see
// discovered-sites.html.
app.get('/api/discovered-sites', async (req, res) => {
  try {
    res.json(await listDiscoveredSites(req.query.status || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve: add the site to the given category's curated scrape list (same
// mechanism as /api/categories above) using its sample URL, then mark it
// approved so it drops off the pending queue.
app.post('/api/discovered-sites/:id/approve', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const category = (req.body?.category || '').trim();
    if (!category) return res.status(400).json({ error: 'A category is required.' });
    const site = (await listDiscoveredSites()).find((s) => s.id === id);
    if (!site) return res.status(404).json({ error: 'Discovered site not found.' });
    const sampleLink = site.sampleUrl || `https://${site.domain}`;
    const result = await addCategorySites(category, [sampleLink]);
    await setDiscoveredSiteStatus(id, 'approved');
    res.json({ ...result, domain: site.domain, category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/discovered-sites/:id/reject', async (req, res) => {
  try {
    await setDiscoveredSiteStatus(Number(req.params.id), 'rejected');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Try the database first (price_audit_items + competitor_products +
// comparison_runs — see checker/db-search.js), falling back to a live web
// search (pipeline.js/runMatch, general discovery — no curated category)
// only when nothing in the database clears the match bar. `onProgress` (if
// given) only fires for the live-search fallback path, since the DB search
// itself is a single fast pass with nothing to stream incrementally.
// db.mode 'single': a well-specified query matched exactly one product,
// site-by-site comparison as before. db.mode 'browse': the query was too
// short/generic for identity matching to ever fire (e.g. "iphone" alone),
// so multiple candidate products are returned instead — see
// checker/db-search.js's BROAD_QUERY_MAX_TOKENS.
// Third source: a direct live lookup on Daraz.lk (see daraz.js), run
// concurrently with the database/web-search path rather than after it, since
// it's an independent network call. Daraz is deliberately left out of the
// generic web-search step (serp.js's DISCOVERY_BLOCKLIST) — this is the
// purpose-built replacement for it, always attached to the result as its own
// `daraz` array (searchDaraz() tries several query variations and can return
// more than one match). Skipped for the DB "browse" mode (many candidate
// products, no single query to match Daraz's results against).
async function runCheckerSearch(query, onProgress = () => {}) {
  const darazPromise = searchDaraz(query.name, query.description).catch((err) => [{
    site: 'Daraz',
    domain: 'daraz.lk',
    status: 'error',
    flags: ['daraz_failed'],
    note: err.message,
  }]);
  // Live fallback for Kapruka's own current price -- price_audit_items (the
  // pre-scraped/audited table, used below for a database match) only has a
  // price for products someone has already run a category audit against, so
  // a query that's never been audited (most of them) had no Kapruka price to
  // recommend against at all. Started eagerly alongside Daraz so it costs no
  // extra latency on whichever branch below ends up needing it.
  const kaprukaRefPromise = findKaprukaProduct(query.name).catch(() => null);
  const db = await searchDatabase(query);
  if (db.hasMatch && db.mode === 'single') {
    // Automatic "ideal price to set" insight -- runs on every single-product
    // search that has both a Kapruka price and at least one real competitor
    // price, no manual trigger. Checker-only by design: one call per search
    // a person actually makes, not something that'd scale to reviewing an
    // entire dashboard's worth of items unattended.
    const competitors = db.results
      .filter((r) => r.price != null && (r.status === 'ok' || r.status === 'low_confidence'))
      .map((r) => ({ site: r.site, price: r.price, matchRate: r.matchRate }));
    const kaprukaRef = db.kaprukaRef?.price ? db.kaprukaRef : await kaprukaRefPromise;
    // Runs even when Kapruka doesn't carry the product (kaprukaRef null) --
    // recommendPrice() falls back to a market-only launch-price suggestion,
    // so every search with at least one competitor price gets an insight.
    const priceInsightPromise = competitors.length
      ? recommendPrice(kaprukaRef, competitors)
      : Promise.resolve(null);
    const [daraz, priceInsight] = await Promise.all([darazPromise, priceInsightPromise]);
    return {
      category: 'Database', query, results: db.results, discovered: [],
      source: 'database', mode: 'single', daraz, kaprukaRef, priceInsight,
    };
  }
  if (db.hasMatch && db.mode === 'browse') {
    return { category: 'Database', query, products: db.products, source: 'database', mode: 'browse' };
  }
  const out = await runMatch(OTHER_CATEGORY, query, onProgress);
  const daraz = await darazPromise;
  const competitors = [...out.results, ...out.discovered, ...daraz]
    .filter((r) => r.price != null && (r.status === 'ok' || r.status === 'low_confidence'))
    .map((r) => ({ site: r.site, price: r.price, matchRate: r.matchRate }));
  const kaprukaRef = competitors.length ? await kaprukaRefPromise : null;
  const priceInsight = competitors.length ? await recommendPrice(kaprukaRef, competitors) : null;
  return { ...out, source: 'web', mode: 'web', daraz, kaprukaRef, priceInsight };
}

// Run a price-checker match. Every query is persisted to the database.
app.post('/api/match', async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const query = { name, description: description || '' };
    const out = await runCheckerSearch(query);
    try {
      out.recordId = await savePriceCheck({ category: out.category, query, result: out });
    } catch (e) {
      console.warn('! failed to persist price check:', e.message);
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streaming price-checker match (Server-Sent Events) so the browser can show
// live progress as each site finishes. Params come via the query string because
// EventSource only does GET.
app.get('/api/match/stream', async (req, res) => {
  const { name, description } = req.query;
  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const query = { name, description: description || '' };
    send('progress', { type: 'db-search-start' });
    const out = await runCheckerSearch(query, (ev) => send('progress', ev));
    if (out.mode === 'single') {
      out.results.forEach((r, i) =>
        send('progress', { type: 'site', phase: 'curated', label: r.site, done: i + 1, total: out.results.length, result: r }),
      );
    } else if (out.mode === 'browse') {
      send('progress', { type: 'db-browse-found', count: out.products.length });
    }
    try {
      out.recordId = await savePriceCheck({ category: out.category, query, result: out });
    } catch (e) {
      console.warn('! failed to persist price check:', e.message);
    }
    send('done', out);
  } catch (err) {
    send('failed', { error: err.message });
  } finally {
    res.end();
  }
});

// Resolve a pasted Kapruka product URL into a query source: scrape the
// product's name, description and Kapruka price. The browser then runs the
// normal match (database search, falling back to live web search) with
// these values, exactly as if the user had typed them in themselves.
app.post('/api/kapruka/resolve', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'A Kapruka product URL is required.' });
  try {
    const product = await fetchKaprukaProduct(url);
    if (!product || !product.name) {
      return res.status(400).json({
        error: 'Could not read a product from that link. Paste a Kapruka product page (kapruka.com/buyonline/...).',
      });
    }
    res.json(product);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Configured partners (drives the comparison dropdown).
app.get('/api/partners', async (_req, res) => {
  try {
    res.json(await listPartners());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// In-memory progress for a background scrape (see /api/compare/progress
// below). A brand-new partner with a large catalog can legitimately take many
// minutes — the Kapruka-side catalog fetch alone can be dozens of pages, and
// the MCP price-hydration fallback (src/compare/mcpPrices.js) opens each
// still-missing product's own page in a real headless browser, one at a time.
// Without this, a long-but-working scrape is indistinguishable from a hang.
const COMPARE_PROGRESS = new Map(); // partnerId -> { lines: string[], startedAt: number }

// Only this local machine (confirmed to get correct LKR pricing from
// Kapruka) should ever scrape live. SCRAPE_ON_ADD=1 in .env marks a host as
// that confirmed-good-geo machine — used both to have adding a partner kick
// off an immediate background scrape (below), and as the general gate on
// refreshAllPartners() doing any live scraping at all (see there). Leave it
// unset everywhere else (e.g. the VPS, confirmed to get USD pricing) so that
// host never scrapes live — a new partner, or a bulk refresh, added/requested
// there just queues a `refresh_requested_at` for the scheduled job
// (src/tools/refresh-all-partners.js) to pick up from the good host instead.
const SCRAPE_ON_ADD = process.env.SCRAPE_ON_ADD === '1';
const TRUSTED_SCRAPE_HOST = SCRAPE_ON_ADD;

// Fire-and-forget: scrape one partner and save the result, tracking progress
// under its id the same way /api/compare/progress already exposes. Used both
// for the immediate background scrape after adding a partner (see below) and
// could be triggered the same way elsewhere later if needed.
async function scrapeAndSaveInBackground(partnerId) {
  const progress = { lines: [], startedAt: Date.now() };
  COMPARE_PROGRESS.set(partnerId, progress);
  const log = (msg) => {
    console.log(`[compare:${partnerId}] ${msg}`);
    progress.lines.push(msg);
    if (progress.lines.length > 30) progress.lines.shift();
  };
  try {
    const data = await runComparison({ partnerId, log });
    await saveComparisonRun(data);
    log(`✓ Done — ${data.summary.kaprukaHigher} overpriced of ${data.summary.matched} matched`);
  } catch (err) {
    log(`✗ Failed: ${err.message}`);
    console.warn(`! background scrape failed for ${partnerId}:`, err.message);
  } finally {
    COMPARE_PROGRESS.delete(partnerId);
  }
}

// Add a new partner: validate the two links, auto-detect the store platform,
// then persist to the shared `partners` table in Supabase. Body: { name, kaprukaUrl, partnerSite }.
app.post('/api/partners', async (req, res) => {
  const { name, kaprukaUrl, partnerSite } = req.body || {};
  if (!name || !kaprukaUrl || !partnerSite) {
    return res.status(400).json({ error: 'name, kaprukaUrl and partnerSite are all required.' });
  }
  const src = parseKaprukaSource(kaprukaUrl);
  if (!src) {
    return res.status(400).json({
      error: 'Could not read the Kapruka link. Paste a partner storefront ' +
        '(kapruka.com/partner/...) or a brand/category page (kapruka.com/online/...).',
    });
  }
  try {
    // 1) Kapruka side must list products for this link.
    const kCount = await probeKaprukaSource(kaprukaUrl);
    if (!kCount) {
      return res.status(400).json({
        error: `No products found on the Kapruka page "${src.label}". Double-check the link.`,
      });
    }
    // 2) Partner site must expose a readable catalogue (WooCommerce or Shopify).
    const { platform, viaBrowser, blocked } = await detectPartnerPlatform(partnerSite);
    if (!platform) {
      const reason = blocked ? 'blocked' : 'unsupported-platform';
      const detail = blocked
        ? 'Site blocks automated requests (Cloudflare/bot protection) even via a real browser.'
        : 'No WooCommerce or Shopify product catalogue was found.';
      await addUnsupportedPartner({ name, kaprukaUrl: src.link, partnerSite, reason, detail }).catch(() => {});
      if (whatsappConfigured()) {
        sendWhatsAppMessage(
          `🔧 New unsupported partner site\n\n` +
            `Name: ${name}\nSite: ${partnerSite}\nReason: ${reason}\n${detail}\n\n` +
            `Needs a custom scraper — see GET /api/unsupported-partners for the full list.`,
        ).catch((err) => console.warn('! WhatsApp notify failed:', err.message));
      }
      return res.status(400).json({
        error: `Could not read a product catalogue from ${siteLabel(partnerSite)}. ` +
          'Supported store platforms are WooCommerce and Shopify. ' +
          "This site has been logged so we can build a custom scraper for it.",
      });
    }
    const site = partnerSite.startsWith('http') ? partnerSite : `https://${partnerSite}`;
    const entry = await addPartner({
      name,
      kaprukaUrl: src.link,
      partnerSite: site,
      partnerLabel: siteLabel(site),
      platform,
      viaBrowser,
    });
    if (SCRAPE_ON_ADD) scrapeAndSaveInBackground(entry.id).catch(() => {});
    res.json({ ...entry, platform, kaprukaPreviewCount: kCount, scraping: SCRAPE_ON_ADD });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Worklist of partner-site requests that couldn't be added automatically (not
// WooCommerce/Shopify, or blocked by bot protection) — for building custom
// scrapers. Nothing else in the app reads this.
app.get('/api/unsupported-partners', async (_req, res) => {
  try {
    res.json(await listUnsupportedPartners());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/compare/progress', (req, res) => {
  const partnerId = req.query.partner || '';
  const state = COMPARE_PROGRESS.get(partnerId);
  if (!state) {
    res.json({ running: false, lines: [], elapsedMs: 0 });
    return;
  }
  res.json({ running: true, lines: state.lines, elapsedMs: Date.now() - state.startedAt });
});

// Mark a partner as wanting a fresh scrape. Doesn't scrape anything itself —
// just records a timestamp; the scheduled job (running from this confirmed-
// good-geo machine) picks it up on its next pass, since that's the only
// place live scraping should ever happen from. Safe to call from any
// instance (the VPS included) — it's just a Supabase write.
app.post('/api/compare/refresh-request', async (req, res) => {
  try {
    const partner = await getPartner(req.query.partner || req.body?.partner);
    await requestRefresh(partner.id);
    res.json({ ok: true, partnerId: partner.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Partner price reconciliation. Always serves the latest STORED run for the
// partner (written by the scheduled refresh job, src/tools/refresh-all-
// partners.js) — never live-scrapes on a page view. Kapruka geo-detects the
// connecting IP, so a live fetch from a host with bad geo pricing would
// produce wrong data; scraping only ever happens from this confirmed-good
// host, either via the scheduled job or the immediate background scrape
// after adding a partner (see SCRAPE_ON_ADD above). If no stored run exists
// yet, this returns a "pending" response instead of blocking on a live
// fetch — the frontend polls /api/compare/progress and re-tries.
app.get('/api/compare', async (req, res) => {
  try {
    const partnerId = req.query.partner || undefined;
    const partner = await getPartner(partnerId);
    const [latest] = await recentComparisonRuns(1, partner.id);
    if (latest) {
      const stored = await getComparisonRun(latest.id);
      if (stored) {
        // Drop team-curated exclusions (see removed_products in db.js) from
        // the matched list and recompute the summary counts to match, so a
        // product removed on any dashboard also disappears from this partner's
        // own comparison view instead of just the aggregate reports.
        const removed = await removedUrlSet();
        if (removed.size) {
          const matched = stored.matched.filter((m) => !removed.has(m.kaprukaUrl));
          res.json({
            ...stored,
            matched,
            summary: summarize({ matched, onlyKapruka: stored.onlyKapruka, onlyPartner: stored.onlyPartner }),
            cached: true,
            stored: true,
          });
          return;
        }
        res.json({ ...stored, cached: true, stored: true });
        return;
      }
    }
    res.json({
      pending: true,
      partner: { id: partner.id, name: partner.name, partnerLabel: partner.partnerLabel },
      message: SCRAPE_ON_ADD
        ? 'This store was just added — check back in a few minutes.'
        : 'This store was just added — check back in about 15 minutes.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- History (stored runs, for downstream use) ----
app.get('/api/history/price-checks', async (req, res) => {
  try {
    res.json(await recentPriceChecks(Number(req.query.limit) || 50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/comparison-runs', async (req, res) => {
  try {
    res.json(await recentComparisonRuns(Number(req.query.limit) || 50, req.query.partner || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/comparison-runs/:id', async (req, res) => {
  try {
    const run = await getComparisonRun(Number(req.params.id));
    if (!run) return res.status(404).json({ error: 'run not found' });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- CSV export (open in Excel / Google Sheets) ----
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

app.get('/api/export/price-checks.csv', async (_req, res) => {
  try {
    sendCsv(res, 'price-checks.csv', await exportPriceChecksCsv());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unified product sheet across both tools — one row per unique product.
// CSV for spreadsheets; JSON (same data) for feeding the product-approval API.
app.get('/api/export/products.csv', async (_req, res) => {
  try {
    sendCsv(res, 'products.csv', await exportProductsCsv());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/products.json', async (_req, res) => {
  try {
    const products = await productRows();
    res.json({ count: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/comparison.csv', async (req, res) => {
  try {
    const partnerId = req.query.partner || null;
    const name = partnerId ? `comparison-${partnerId}.csv` : 'comparison.csv';
    sendCsv(res, name, await exportComparisonCsv(partnerId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Overpriced dashboard (every overpriced product across all partners) ----
// Reads the latest stored comparison run per partner; refreshed daily by the
// scheduler below (or on demand via POST /api/overpriced/refresh).
app.get('/api/overpriced', async (_req, res) => {
  try {
    res.json({ ...(await overpricedReport()), refreshing: REFRESH_STATE.running });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// "Refresh all stores" is a full-catalogue live scrape (127 partners' worth
// of Kapruka + partner-site fetches) once the trusted machine's scheduled job
// picks it up — capped to avoid someone repeatedly mashing the button and
// tripping Kapruka's rate limiting (see the 429-handling notes in
// src/compare/sources.js) or just hammering every partner site needlessly.
// Counted from bulk_refresh_log (shared Supabase table, so a click on either
// instance counts against the same daily total), reset at Sri Lanka midnight
// since that's the actual business day this app runs against.
const BULK_REFRESH_DAILY_LIMIT = 2;
const SRI_LANKA_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function startOfTodaySriLanka() {
  const nowSL = new Date(Date.now() + SRI_LANKA_OFFSET_MS);
  const midnightSL = Date.UTC(nowSL.getUTCFullYear(), nowSL.getUTCMonth(), nowSL.getUTCDate());
  return new Date(midnightSL - SRI_LANKA_OFFSET_MS).toISOString();
}

app.post('/api/overpriced/refresh', async (_req, res) => {
  try {
    const usedToday = await countBulkRefreshesSince(startOfTodaySriLanka());
    if (usedToday >= BULK_REFRESH_DAILY_LIMIT) {
      return res.status(429).json({
        error: `Daily limit reached (${BULK_REFRESH_DAILY_LIMIT}/${BULK_REFRESH_DAILY_LIMIT}) for "Refresh all stores" — try again tomorrow.`,
      });
    }
    await logBulkRefreshRequest();
    const result = await refreshAllPartners('manual');
    res.json({
      ...(await overpricedReport()),
      refreshing: false,
      queued: result?.queued ?? null,
      message: result?.queued
        ? `This host doesn't scrape live (bad Kapruka geo-pricing) — queued ${result.queued} stores for the trusted machine's scheduled job to pick up within 15 minutes.`
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/overpriced.csv', async (req, res) => {
  try {
    const partnerId = req.query.partner || null;
    const category = req.query.category || null;
    const suffix = [partnerId, category].filter(Boolean).join('-');
    const name = suffix ? `overpriced-${suffix}.csv` : 'overpriced.csv';
    sendCsv(res, name, await exportOverpricedCsv(partnerId, category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- All Products Overpriced dashboard (partners + the 5-category audit
// crawl combined) — see allProductsOverpricedReport() in export.js. Always
// computed live from current data (price_audit_items/competitor_products
// refresh on their own schedule via the audit scripts, comparison_runs via
// the daily partner refresh below), so there's no separate cache to bust.
app.get('/api/overpriced/all', async (_req, res) => {
  try {
    res.json(await allProductsOverpricedReport());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/overpriced-all.csv', async (_req, res) => {
  try {
    sendCsv(res, 'overpriced-all.csv', await exportAllProductsOverpricedCsv());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Stock mismatch dashboard — see stockMismatchReport() in export.js ----
// Matched products where our Kapruka listing and the partner's own site
// disagree on stock status, split into the two directions.
app.get('/api/stock-mismatch', async (_req, res) => {
  try {
    res.json({ ...(await stockMismatchReport()), refreshing: REFRESH_STATE.running });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/stock-mismatch.csv', async (req, res) => {
  try {
    const direction = ['kapruka', 'both'].includes(req.query.direction) ? req.query.direction : 'partner';
    const partnerId = req.query.partner || null;
    const category = req.query.category || null;
    const suffix = [direction, partnerId, category].filter(Boolean).join('-');
    sendCsv(res, `stock-${suffix}.csv`, await exportStockMismatchCsv(direction, partnerId, category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Price Changes dashboard — competitor price moved between the previous
// and latest stored scrape for a partner. See priceChangesReport() in
// export.js. Always computed live (needs the two most recent runs per
// partner, not just the latest), so there's no separate cache to bust — it
// updates automatically as refresh-all-partners.js / the daily refresh below
// store new runs.
app.get('/api/price-changes', async (_req, res) => {
  try {
    res.json({ ...(await priceChangesReport()), refreshing: REFRESH_STATE.running });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/price-changes.csv', async (req, res) => {
  try {
    const partnerId = req.query.partner || null;
    const direction = ['increased', 'decreased'].includes(req.query.direction) ? req.query.direction : null;
    const suffix = [partnerId, direction].filter(Boolean).join('-');
    const name = suffix ? `price-changes-${suffix}.csv` : 'price-changes.csv';
    sendCsv(res, name, await exportPriceChangesCsv(partnerId, direction));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Removed products (team-curated exclusions) ---------------------------
// A shared "Removed Products" list read by all three overpriced dashboards
// (Partner Comparison, Partner Overpriced, All Products Overpriced). Removing
// a product here (keyed by its Kapruka URL) hides it from every one of those
// views' reports — see removedUrlSet() usage in export.js and the /api/compare
// handler above — and it stays hidden until restored from this same list.
app.get('/api/removed-products', async (_req, res) => {
  try {
    res.json(await listRemovedProducts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/removed-products', async (req, res) => {
  const { kaprukaUrl, name, category, partnerName, reason, removedBy, sourcePage, snapshot } = req.body || {};
  if (!kaprukaUrl || !String(reason || '').trim() || !String(removedBy || '').trim()) {
    return res.status(400).json({ error: 'kaprukaUrl, a reason, and the name of who removed it are required.' });
  }
  try {
    const row = await addRemovedProduct({
      kaprukaUrl,
      name: name || '',
      category: category || '',
      partnerName: partnerName || '',
      reason: String(reason).trim(),
      removedBy: String(removedBy).trim(),
      sourcePage: sourcePage || '',
      snapshot: snapshot || {},
    });
    invalidateReportCache();
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/removed-products/:id', async (req, res) => {
  try {
    await deleteRemovedProduct(Number(req.params.id));
    invalidateReportCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Periodic auto-refresh of every partner comparison ---------------------
// The Overpriced dashboard reads stored runs, so something must keep them
// fresh. On a fixed interval (and on startup if the newest run is stale) we
// re-run every partner's reconciliation and persist it. Set
// DISABLE_AUTO_REFRESH=1 to turn this off (e.g. in dev, or when a separate
// scheduled job owns the refresh).
//
// Was once/24h, which meant a Kapruka price change could sit stale on the
// dashboard for up to a day even though nothing else was wrong (see the
// 2026-08-18 3000store/Mac Styler case — a price update on Kapruka's live
// site simply hadn't been re-scraped yet). Default is now every few hours;
// override with AUTO_REFRESH_HOURS. Kept well above the trusted host's 15-min
// pending-request poll (src/tools/refresh-all-partners.js) since this sweep
// queues/scrapes *every* partner regardless of pending requests, not just
// the ones flagged — too short a value risks tripping Kapruka's rate limit
// (see the 429-handling notes in src/compare/sources.js).
//
// NOTE: this fetches Kapruka live, so it only yields correct LKR prices when the
// host is in Sri Lanka (or behind a SL proxy). From abroad Kapruka returns USD,
// which the catalogue parser drops — those products show as "price missing", not
// overpriced. See SCRAPE_PROXY in compare/sources.js.
const AUTO_REFRESH_MS = (Number(process.env.AUTO_REFRESH_HOURS) || 4) * 60 * 60 * 1000;
const REFRESH_STATE = { running: false, lastRunAt: null };

async function refreshAllPartners(reason) {
  // Never live-scrape from a host that isn't confirmed-good-geo (see
  // TRUSTED_SCRAPE_HOST above) — Kapruka would serve USD instead of LKR, and
  // a force-refresh would silently overwrite good stored data with
  // price-missing results for every partner. Instead, queue a refresh
  // request per partner (the same Supabase flag the single-store Refresh
  // button writes) so the scheduled job on the trusted host picks them up.
  if (!TRUSTED_SCRAPE_HOST) {
    const partners = await listPartners();
    console.log(`↻ Not a trusted-geo host — queuing ${partners.length} refresh requests instead of scraping (${reason})`);
    await Promise.all(partners.map((p) => requestRefresh(p.id)));
    REFRESH_STATE.lastRunAt = new Date().toISOString();
    return { queued: partners.length };
  }
  if (REFRESH_STATE.running) {
    console.log('↻ refresh already in progress, skipping');
    return { skipped: true };
  }
  REFRESH_STATE.running = true;
  const startedAt = Date.now();
  try {
    const partners = await listPartners();
    console.log(`↻ Refreshing ${partners.length} partner comparisons (${reason})…`);
    let refreshed = 0;
    for (const p of partners) {
      try {
        const data = await runComparison({ partnerId: p.id, force: true });
        if (!data.cached) await saveComparisonRun(data);
        refreshed += 1;
        console.log(`  ✓ ${p.name}: ${data.summary.kaprukaHigher} overpriced of ${data.summary.matched} matched`);
      } catch (err) {
        console.warn(`  ! ${p.name}: ${err.message}`);
      }
    }
    REFRESH_STATE.lastRunAt = new Date().toISOString();
    console.log(`↻ Refresh done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return { refreshed };
  } finally {
    REFRESH_STATE.running = false;
  }
}

// Kick a refresh on startup only if the newest stored run is older than the
// sweep interval, so frequent dev restarts don't hammer the live sites. Runs
// in the background (non-blocking) so the server starts serving immediately.
async function refreshIfStale() {
  try {
    const [newest] = await recentComparisonRuns(1);
    const ageMs = newest ? Date.now() - new Date(newest.created_at).getTime() : Infinity;
    if (ageMs >= AUTO_REFRESH_MS) {
      refreshAllPartners(newest ? 'startup: data is stale' : 'startup: no data yet');
    } else {
      const mins = Math.round(ageMs / 60000);
      console.log(`↻ Skipping startup refresh — newest run is ${mins}min old (< ${AUTO_REFRESH_MS / 3600000}h).`);
    }
  } catch (err) {
    console.warn('! startup refresh check failed:', err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Price tools running at http://localhost:${PORT}`);
  const backendLabel = {
    sqlite: 'sqlite (local file; set DATABASE_URL or SUPABASE_URL/SUPABASE_SERVICE_KEY for Supabase)',
    postgres: 'postgres (Supabase, direct connection)',
    'supabase-rest': 'supabase-rest (Supabase, over HTTPS)',
  }[storageKind];
  console.log(`Storage backend: ${backendLabel}`);
  if (!process.env.OPENAI_API_KEY) console.warn('! OPENAI_API_KEY is not set');
  if (!process.env.SERP_API_KEY) console.warn('! SERP_API_KEY is not set');

  if (process.env.DISABLE_AUTO_REFRESH === '1') {
    console.log('↻ Auto-refresh disabled (DISABLE_AUTO_REFRESH=1).');
  } else {
    console.log(`↻ Auto-refresh sweep every ${AUTO_REFRESH_MS / 3600000}h (override with AUTO_REFRESH_HOURS).`);
    refreshIfStale();
    setInterval(() => refreshAllPartners('scheduled sweep'), AUTO_REFRESH_MS);
  }
});
