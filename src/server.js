import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadCategories, runMatch } from './pipeline.js';
import { runComparison } from './compare/run.js';
import { listPartners, addPartner, siteLabel } from './compare/partners.js';
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
} from './db.js';
import {
  exportPriceChecksCsv,
  exportComparisonCsv,
  exportProductsCsv,
  exportOverpricedCsv,
  overpricedReport,
  productRows,
} from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// Categories + their sites (drives the dropdown).
app.get('/api/categories', async (_req, res) => {
  try {
    const categories = await loadCategories();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run a price-checker match. Every query is persisted to the database.
app.post('/api/match', async (req, res) => {
  const { category, name, description } = req.body || {};
  if (!category || !name) {
    return res.status(400).json({ error: 'category and name are required' });
  }
  try {
    const query = { name, description: description || '' };
    const out = await runMatch(category, query);
    try {
      out.recordId = await savePriceCheck({ category, query, result: out });
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
  const { category, name, description } = req.query;
  if (!category || !name) {
    return res.status(400).json({ error: 'category and name are required' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const query = { name, description: description || '' };
    const out = await runMatch(category, query, (ev) => send('progress', ev));
    try {
      out.recordId = await savePriceCheck({ category, query, result: out });
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

// Map Kapruka's own category string (e.g. "ELECTRONICS", "MOBILE PHONES") onto
// one of our price-checker category keys, so a pasted product link can pre-select
// the right category. Returns null if nothing fits (the UI then keeps the
// user's current selection).
function matchCategory(kaprukaCat, keys) {
  if (!kaprukaCat) return null;
  const c = String(kaprukaCat).toLowerCase();
  for (const k of keys) if (k.toLowerCase() === c) return k;
  for (const k of keys) if (c.includes(k.toLowerCase()) || k.toLowerCase().includes(c)) return k;
  if (/phone|mobile|smartphone/.test(c)) return keys.find((k) => /mobile/i.test(k)) || null;
  if (/electronic|tv|audio|speaker|laptop|computer|camera/.test(c)) {
    return keys.find((k) => /electronic/i.test(k)) || null;
  }
  if (/grocery|food|beverage/.test(c)) return keys.find((k) => /grocery/i.test(k)) || null;
  if (/cosmetic|beauty|skin|fragrance|perfume/.test(c)) return keys.find((k) => /cosmetic/i.test(k)) || null;
  if (/cake|bakery/.test(c)) return keys.find((k) => /cake/i.test(k)) || null;
  return null;
}

// Resolve a pasted Kapruka product URL into a query source: scrape the product's
// name, description and Kapruka price, and suggest a matching category. The
// browser then runs the normal match with these values.
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
    const categories = await loadCategories();
    product.suggestedCategory = matchCategory(product.category, Object.keys(categories));
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

// Add a new partner: validate the two links, auto-detect the store platform,
// then persist to config/partners.json. Body: { name, kaprukaUrl, partnerSite }.
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
    const platform = await detectPartnerPlatform(partnerSite);
    if (!platform) {
      return res.status(400).json({
        error: `Could not read a product catalogue from ${siteLabel(partnerSite)}. ` +
          'Supported store platforms are WooCommerce and Shopify.',
      });
    }
    const site = partnerSite.startsWith('http') ? partnerSite : `https://${partnerSite}`;
    const entry = await addPartner({
      name,
      kaprukaUrl: src.link,
      partnerSite: site,
      partnerLabel: siteLabel(site),
      platform,
    });
    res.json({ ...entry, platform, kaprukaPreviewCount: kCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Partner price reconciliation. Result is cached in memory per partner for 30
// min; ?refresh=1 forces a live refetch (~10s). Any run that actually recomputes
// (a refresh or a cache miss) is persisted as a new timestamped row; cached
// responses are not re-stored.
app.get('/api/compare', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const partnerId = req.query.partner || undefined;
    const data = await runComparison({ partnerId, force });
    if (!data.cached) {
      try {
        data.recordId = await saveComparisonRun(data);
      } catch (e) {
        console.warn('! failed to persist comparison run:', e.message);
      }
    }
    res.json(data);
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

app.get('/api/export/overpriced.csv', async (_req, res) => {
  try {
    sendCsv(res, 'overpriced.csv', await exportOverpricedCsv());
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
  console.log(`Storage backend: ${storageKind}${storageKind === 'sqlite' ? ' (local file; set DATABASE_URL for Supabase)' : ' (Supabase/Postgres)'}`);
  if (!process.env.OPENAI_API_KEY) console.warn('! OPENAI_API_KEY is not set');
  if (!process.env.SERP_API_KEY) console.warn('! SERP_API_KEY is not set');

  if (process.env.DISABLE_AUTO_REFRESH === '1') {
    console.log('↻ Daily auto-refresh disabled (DISABLE_AUTO_REFRESH=1).');
  } else {
    refreshIfStale();
    setInterval(() => refreshAllPartners('daily schedule'), DAILY_MS);
  }
});
