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
} from './db.js';
import {
  exportPriceChecksCsv,
  exportComparisonCsv,
  exportProductsCsv,
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
      out.recordId = savePriceCheck({ category, query, result: out });
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
      out.recordId = savePriceCheck({ category, query, result: out });
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
        data.recordId = saveComparisonRun(data);
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
app.get('/api/history/price-checks', (req, res) => {
  try {
    res.json(recentPriceChecks(Number(req.query.limit) || 50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/comparison-runs', (req, res) => {
  try {
    res.json(recentComparisonRuns(Number(req.query.limit) || 50, req.query.partner || null));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/comparison-runs/:id', (req, res) => {
  try {
    const run = getComparisonRun(Number(req.params.id));
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

app.get('/api/export/price-checks.csv', (_req, res) => {
  try {
    sendCsv(res, 'price-checks.csv', exportPriceChecksCsv());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unified product sheet across both tools — one row per unique product.
// CSV for spreadsheets; JSON (same data) for feeding the product-approval API.
app.get('/api/export/products.csv', (_req, res) => {
  try {
    sendCsv(res, 'products.csv', exportProductsCsv());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/products.json', (_req, res) => {
  try {
    const products = productRows();
    res.json({ count: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/export/comparison.csv', (req, res) => {
  try {
    const partnerId = req.query.partner || null;
    const name = partnerId ? `comparison-${partnerId}.csv` : 'comparison.csv';
    sendCsv(res, name, exportComparisonCsv(partnerId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Price tools running at http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) console.warn('! OPENAI_API_KEY is not set');
  if (!process.env.SERP_API_KEY) console.warn('! SERP_API_KEY is not set');
});
