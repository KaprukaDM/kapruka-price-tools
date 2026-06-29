// ═══════════════════════════════════════════════════════════════
// HOT PRODUCTS MATCH SERVICE  (standalone — separate from src/server.js)
// ═══════════════════════════════════════════════════════════════
// A small, independent Express app for the weekly Hot Products board. It does
// NOT touch the Price Checker / Partner Comparison server — it only reuses the
// shared, read-only scraper helpers (scrape.js, matcher.js).
//
// Scope (for now): MATCH RATE ONLY. Given a suggested product URL and its
// Kapruka listing URL, it scrapes each page's title and scores how confident we
// are they're the same product. No prices — those need a headless browser for
// sites like Daraz (active price is JS-rendered), which the free tier can't run.
//
// Endpoint:
//   POST /api/hot-products/compare  { suggestedUrl, kaprukaUrl }  -> match rate
//
// Run locally:   npm run hot         (default port 3100, override with HOT_PORT)

import 'dotenv/config';
import express from 'express';

import { scrapeProduct } from './scrape.js';
import { scoreIdentity } from './matcher.js';

const app = express();
app.use(express.json());

// CORS — the board is a static page served from another origin (Cloudflare,
// GitHub Pages, file://, …). Allow any origin for these read-only calls.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Scrape just the product title from a URL (prices are intentionally ignored).
async function readTitle(url) {
  const scraped = await scrapeProduct(url);
  return { title: scraped.title, flags: scraped.flags || [] };
}

app.get('/', (_req, res) => res.json({ service: 'hot-products-match' }));

// Compare a suggested product to its Kapruka listing → match rate (same product?).
app.post('/api/hot-products/compare', async (req, res) => {
  const { suggestedUrl, kaprukaUrl } = req.body || {};
  if (!suggestedUrl || !kaprukaUrl) {
    return res.status(400).json({ error: 'suggestedUrl and kaprukaUrl are required' });
  }
  try {
    const suggested = await readTitle(suggestedUrl);
    const kapruka = await readTitle(kaprukaUrl);
    const match = await scoreIdentity(
      { name: suggested.title || 'product', description: '' },
      { title: kapruka.title, url: kaprukaUrl },
    );
    const matchRate = Number.isFinite(match.matchRate) ? match.matchRate : 0;
    res.json({
      suggestedTitle: suggested.title,
      kaprukaTitle: kapruka.title,
      matchRate,
      isSameProduct: !!match.isSameModel,
      reasoning: match.reasoning || '',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.HOT_PORT || process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`Hot Products match service running at http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) console.warn('! OPENAI_API_KEY is not set (match rate needs it)');
});
