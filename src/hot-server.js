// ═══════════════════════════════════════════════════════════════
// HOT PRODUCTS PRICE SERVICE  (standalone — separate from src/server.js)
// ═══════════════════════════════════════════════════════════════
// A small, independent Express app for the weekly Hot Products board. It does
// NOT touch the Price Checker / Partner Comparison server — it only reuses the
// shared, read-only scraper helpers (scrape.js, matcher.js, compare/sources.js).
//
// Endpoints:
//   POST /api/hot-products/scrape   { url }                       -> price of one product
//   POST /api/hot-products/compare  { suggestedUrl, kaprukaUrl }  -> match rate + price diff
//
// Run locally:   npm run hot         (default port 3100, override with HOT_PORT)
//
// The "270 rule": this service runs outside Sri Lanka (Render/Singapore), where
// many foreign shops — and Kapruka's *visible* price — render in USD. The board
// works in rupees, so any USD figure is converted to LKR at HOT_USD_LKR (270).
// Kapruka product pages still carry canonical LKR in JSON-LD (fetchKaprukaProduct),
// so only genuine USD pages get converted.

import 'dotenv/config';
import express from 'express';

import { scrapeProduct } from './scrape.js';
import { scoreMatch } from './matcher.js';

const app = express();
app.use(express.json());

// CORS — the board is a static page that may be served from another origin
// (GitHub Pages, file://, …). Allow any origin for these read-only calls.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const HOT_USD_LKR = Number(process.env.HOT_USD_LKR) || 270;

function toLkr(value, currency) {
  if (value == null) return { lkr: null, note: null };
  const cur = String(currency || '').toUpperCase();
  if (cur === 'USD') return { lkr: Math.round(value * HOT_USD_LKR), note: `USD×${HOT_USD_LKR}` };
  if (cur === 'LKR' || cur === '') return { lkr: Math.round(value), note: null };
  // Any other currency: don't fabricate a conversion — keep the number, flag it.
  return { lkr: Math.round(value), note: `treated ${cur} as LKR` };
}

// Pick the full current selling price from a scraped page. Reuses the AI matcher
// (it filters out installments/deposits/accessories) by querying the page against
// its own title, then falls back to the largest captured price.
async function pickFullPrice(scraped) {
  const m = await scoreMatch({ name: scraped.title || 'product', description: '' }, scraped);
  let value = m && m.chosenPriceValue != null ? m.chosenPriceValue : null;
  let currency = (m && m.chosenPriceCurrency) || scraped.currency || null;
  if (value == null && Array.isArray(scraped.prices) && scraped.prices.length) {
    const top = scraped.prices.reduce((a, b) => (b.value > a.value ? b : a));
    value = top.value;
    currency = currency || top.currency;
  }
  return { value, currency };
}

// Read one product URL into normalised hot-product fields (price always in LKR).
// Uses the generic scraper for ALL sites (incl. Kapruka): it parses prices with
// decimals intact, so a geo-converted "$37.03" stays 37.03 — not 3703.
// Returns a `candidate` (scrape-shaped) so the caller can run the matcher on it.
async function readHotProduct(url) {
  const scraped = await scrapeProduct(url);
  const { value, currency } = await pickFullPrice(scraped);
  const conv = toLkr(value, currency);
  return { title: scraped.title, price: conv.lkr, currency: currency || null, priceNote: conv.note, flags: scraped.flags || [], candidate: scraped };
}

function stripCandidate({ candidate, ...rest }) {
  return rest;
}

app.get('/', (_req, res) => res.json({ service: 'hot-products-price', usdToLkr: HOT_USD_LKR }));

// Pull a single product's price (used when a suggestion link is added).
app.post('/api/hot-products/scrape', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });
  try {
    res.json(stripCandidate(await readHotProduct(url)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Compare a suggested product to its Kapruka listing: match rate + both prices
// (LKR) + the difference (kapruka − suggested; negative means Kapruka is cheaper).
app.post('/api/hot-products/compare', async (req, res) => {
  const { suggestedUrl, kaprukaUrl } = req.body || {};
  if (!suggestedUrl || !kaprukaUrl) {
    return res.status(400).json({ error: 'suggestedUrl and kaprukaUrl are required' });
  }
  try {
    const suggested = await readHotProduct(suggestedUrl);
    const kapruka = await readHotProduct(kaprukaUrl);
    const match = await scoreMatch({ name: suggested.title || 'product', description: '' }, kapruka.candidate);
    const matchRate = Number.isFinite(match.matchRate) ? match.matchRate : 0;
    const priceDiff =
      suggested.price != null && kapruka.price != null ? kapruka.price - suggested.price : null;
    res.json({
      suggested: stripCandidate(suggested),
      kapruka: stripCandidate(kapruka),
      matchRate,
      isSameProduct: !!match.isSameProduct,
      priceDiff,
      reasoning: match.reasoning || '',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.HOT_PORT || process.env.PORT || 3100;
app.listen(PORT, () => {
  console.log(`Hot Products price service running at http://localhost:${PORT}`);
  console.log(`USD→LKR rate (270 rule): ${HOT_USD_LKR}`);
  if (!process.env.OPENAI_API_KEY) console.warn('! OPENAI_API_KEY is not set (match rate needs it)');
});
