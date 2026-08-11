import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadCategories, runMatch, addCategorySites, OTHER_CATEGORY } from './pipeline.js';
import { searchDatabase } from './checker/db-search.js';
import { runComparison } from './compare/run.js';
import { listPartners, addPartner, siteLabel, getPartner, requestRefresh } from './compare/partners.js';
import {
  probeKaprukaSource,
  detectPartnerPlatform,
  parseKaprukaSource,
  fetchKaprukaProduct,
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
  productRows,
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
async function runCheckerSearch(query, onProgress = () => {}) {
  const db = await searchDatabase(query);
  if (db.hasMatch && db.mode === 'single') {
    return { category: 'Database', query, results: db.results, discovered: [], source: 'database', mode: 'single' };
  }
  if (db.hasMatch && db.mode === 'browse') {
    return { category: 'Database', query, products: db.products, source: 'database', mode: 'browse' };
  }
  const out = await runMatch(OTHER_CATEGORY, query, onProgress);
  return { ...out, source: 'web', mode: 'web' };
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
// Kapruka) should ever scrape live. Set SCRAPE_ON_ADD=1 in .env on a
// confirmed-good-geo host to have adding a partner kick off an immediate
// background scrape for faster turnaround; leave it unset everywhere else
// (e.g. the VPS, confirmed to get USD pricing) so a new partner there just
// waits for the scheduled job (src/tools/refresh-all-partners.js) to pick it
// up from the good host instead.
const SCRAPE_ON_ADD = process.env.SCRAPE_ON_ADD === '1';

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

app.post('/api/overpriced/refresh', async (_req, res) => {
  try {
    await refreshAllPartners('manual');
    res.json({ ...(await overpricedReport()), refreshing: false });
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
  const { kaprukaUrl, name, category, partnerName, reason, sourcePage, snapshot } = req.body || {};
  if (!kaprukaUrl || !String(reason || '').trim()) {
    return res.status(400).json({ error: 'kaprukaUrl and a reason are required.' });
  }
  try {
    const row = await addRemovedProduct({
      kaprukaUrl,
      name: name || '',
      category: category || '',
      partnerName: partnerName || '',
      reason: String(reason).trim(),
      sourcePage: sourcePage || '',
      snapshot: snapshot || {},
    });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/removed-products/:id', async (req, res) => {
  try {
    await deleteRemovedProduct(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily auto-refresh of every partner comparison -----------------------
// The Overpriced dashboard reads stored runs, so something must keep them
// fresh. Once a day (and on startup if the newest run is stale) we re-run every
// partner's reconciliation and persist it. Set DISABLE_AUTO_REFRESH=1 to turn
// this off (e.g. in dev, or when a separate scheduled job owns the refresh).
//
// NOTE: this fetches Kapruka live, so it only yields correct LKR prices when the
// host is in Sri Lanka (or behind a SL proxy). From abroad Kapruka returns USD,
// which the catalogue parser drops — those products show as "price missing", not
// overpriced. See SCRAPE_PROXY in compare/sources.js.
const DAILY_MS = 24 * 60 * 60 * 1000;
const REFRESH_STATE = { running: false, lastRunAt: null };

async function refreshAllPartners(reason) {
  if (REFRESH_STATE.running) {
    console.log('↻ refresh already in progress, skipping');
    return;
  }
  REFRESH_STATE.running = true;
  const startedAt = Date.now();
  try {
    const partners = await listPartners();
    console.log(`↻ Refreshing ${partners.length} partner comparisons (${reason})…`);
    for (const p of partners) {
      try {
        const data = await runComparison({ partnerId: p.id, force: true });
        if (!data.cached) await saveComparisonRun(data);
        console.log(`  ✓ ${p.name}: ${data.summary.kaprukaHigher} overpriced of ${data.summary.matched} matched`);
      } catch (err) {
        console.warn(`  ! ${p.name}: ${err.message}`);
      }
    }
    REFRESH_STATE.lastRunAt = new Date().toISOString();
    console.log(`↻ Refresh done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } finally {
    REFRESH_STATE.running = false;
  }
}

// Kick a refresh on startup only if the newest stored run is older than a day,
// so frequent dev restarts don't hammer the live sites. Runs in the background
// (non-blocking) so the server starts serving immediately.
async function refreshIfStale() {
  try {
    const [newest] = await recentComparisonRuns(1);
    const ageMs = newest ? Date.now() - new Date(newest.created_at).getTime() : Infinity;
    if (ageMs >= DAILY_MS) {
      refreshAllPartners(newest ? 'startup: data is stale' : 'startup: no data yet');
    } else {
      const hrs = Math.round(ageMs / 3600000);
      console.log(`↻ Skipping startup refresh — newest run is ${hrs}h old (< 24h).`);
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
    console.log('↻ Daily auto-refresh disabled (DISABLE_AUTO_REFRESH=1).');
  } else {
    refreshIfStale();
    setInterval(() => refreshAllPartners('daily schedule'), DAILY_MS);
  }
});
