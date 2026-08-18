import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectProducts, termFromUrl } from './lib/kapruka.js';
import { scoreRelevancy } from './lib/relevancy.js';
import { createJob, getJob, jobSummary } from './lib/bulk.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load the current listing as-is (no AI) — this is "the current view".
app.post('/api/fetch', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/kapruka\.com/i.test(url)) {
    return res.status(400).json({ error: 'Paste a valid kapruka.com find_online link.' });
  }
  try {
    const term = termFromUrl(url);
    const products = await collectProducts(url, { log: console.log });
    res.json({ term, sourceUrl: url, products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// AI-sort the products already loaded on the page.
app.post('/api/sort', async (req, res) => {
  const { term, products } = req.body || {};
  if (!term || !Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ error: 'Missing term or products to sort.' });
  }
  try {
    const ranked = await scoreRelevancy(term, products, { log: console.log });
    res.json({ term, products: ranked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk mode: paste many find_online links, run fetch+AI-sort across all of
// them as a background job (small concurrency pool), poll for progress.
app.post('/api/bulk', (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Provide a non-empty array of urls.' });
  }
  const cleaned = urls.map((u) => String(u).trim()).filter(Boolean);
  const bad = cleaned.find((u) => !/kapruka\.com/i.test(u));
  if (bad) return res.status(400).json({ error: `Not a kapruka.com link: ${bad}` });
  const job = createJob(cleaned);
  res.json({ jobId: job.id });
});

// Poll job progress + per-link summary (no product lists — keep polls cheap).
app.get('/api/bulk/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(jobSummary(job));
});

// Full ranked product list for one link in a job, fetched on demand when a
// row is expanded in the UI.
app.get('/api/bulk/:id/link/:index', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const link = job.links[Number(req.params.index)];
  if (!link) return res.status(404).json({ error: 'Link not found' });
  res.json(link);
});

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`Kapruka relevancy sorter running at http://localhost:${PORT}`);
});
