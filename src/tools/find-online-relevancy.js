// Standalone tool: given one or more Kapruka "find_online" search/category URLs
// (e.g. https://www.kapruka.com/lk/find_online/almond), pull up to N products per
// URL using the same request pattern Kapruka's own "See More Products" button
// uses, then ask OpenAI (vision) to score how relevant each product actually is
// to the search term and re-sort the list by relevancy.
//
// Links are grabbed the reliable way — parsing the JSON-LD <script> blocks
// Kapruka embeds per product card (title, url, image, price, currency) — not
// via vision. Vision is used only for the judgement step, where it looks at
// the product photo + title together to catch results the text search pulled
// in loosely (gift hampers, unrelated cosmetics, etc. that just happen to
// mention the search term).
//
// Usage:
//   node src/tools/find-online-relevancy.js <url> [url2] [url3] ...
//   node src/tools/find-online-relevancy.js --file urls.txt
//
// Output: out/relevancy-<term>.json and out/relevancy-<term>.csv per URL.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import 'dotenv/config';

const MODEL = process.env.RELEVANCY_MODEL || 'gpt-4o-mini';
const PRODUCT_LIMIT = Number(process.env.RELEVANCY_LIMIT || 60);
const PAGE_SAFETY_CAP = 8; // hard stop even if the site keeps returning "new" pages
const BATCH_SIZE = 10; // products per vision call
const OUT_DIR = fileURLToPath(new URL('../../out/', import.meta.url));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let client = null;
function getClient() {
  if (!client) client = new OpenAI(); // reads OPENAI_API_KEY from env
  return client;
}

// ---------------------------------------------------------------------------
// Fetching + parsing the listing pages

async function fetchListingHtml(url, refererUrl) {
  const headers = {
    'User-Agent': UA,
    'Accept-Language': 'en-LK,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  if (refererUrl) {
    headers['Referer'] = refererUrl;
    headers['X-Requested-With'] = 'XMLHttpRequest';
  }
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

// Kapruka embeds one <script type="application/ld+json"> Product block per
// product card. Pull those directly rather than guessing at CSS classes.
function parseListingProducts(html) {
  const $ = cheerio.load(html);
  const products = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let json;
    try {
      json = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = Array.isArray(json) ? json : [json];
    for (const node of nodes) {
      if (node['@type'] !== 'Product') continue;
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers;
      const image = Array.isArray(node.image) ? node.image[0] : node.image;
      products.push({
        title: node.name || null,
        url: node.url || null,
        image: image || null,
        price: offer?.price != null ? Number(offer.price) : null,
        currency: offer?.priceCurrency || null,
      });
    }
  });
  return products;
}

// The listing page's "See More Products" button carries the exact URL template
// Kapruka's own frontend uses for pagination, e.g.
//   paginate('/srilanka_online_shopping.jsp?d=almond&islk=lk&p=2')
// Reuse it verbatim instead of hand-building query params.
function findPaginationTemplate(html, baseUrl) {
  const m = html.match(/paginate\('([^']+)'\)/);
  if (!m) return null;
  return new URL(m[1], baseUrl).toString();
}

function withPage(templateUrl, page) {
  const u = new URL(templateUrl);
  u.searchParams.set('p', String(page));
  return u.toString();
}

/**
 * Collect up to `limit` products from a Kapruka find_online URL, following
 * its own pagination (~30 products/page) until the limit is hit, a page
 * yields no new products, or the safety cap is reached.
 */
async function collectProducts(listingUrl, { limit = PRODUCT_LIMIT, log = () => {} } = {}) {
  const seen = new Map(); // url -> product
  const firstHtml = await fetchListingHtml(listingUrl);
  for (const p of parseListingProducts(firstHtml)) {
    if (p.url) seen.set(p.url, p);
  }
  log(`  page 1: ${seen.size} products`);

  const template = findPaginationTemplate(firstHtml, listingUrl);
  let page = 2;
  while (template && seen.size < limit && page <= PAGE_SAFETY_CAP) {
    const pageUrl = withPage(template, page);
    let html;
    try {
      html = await fetchListingHtml(pageUrl, listingUrl);
    } catch (err) {
      log(`  page ${page}: fetch failed (${err.message}), stopping`);
      break;
    }
    const before = seen.size;
    for (const p of parseListingProducts(html)) {
      if (p.url && !seen.has(p.url)) seen.set(p.url, p);
    }
    const added = seen.size - before;
    log(`  page ${page}: +${added} new (total ${seen.size})`);
    if (added === 0) break; // ran out of results
    page += 1;
  }

  return Array.from(seen.values()).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Relevancy scoring (OpenAI vision)

const REPORT_RELEVANCY_FN = {
  name: 'report_relevancy',
  description:
    'Report how relevant each numbered product (photo + title) is to the search term.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The item number given in the prompt.' },
            relevancyScore: {
              type: 'integer',
              description:
                '0-100. 100 = exactly what a shopper searching this term wants. Low scores for ' +
                'items that only surfaced because the term appears loosely in the title/description ' +
                '(unrelated gift hampers, accessories, or other products that merely mention the word).',
            },
            reasoning: { type: 'string', description: 'One short sentence.' },
          },
          required: ['index', 'relevancyScore', 'reasoning'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

async function scoreBatch(term, batch) {
  const content = [
    {
      type: 'text',
      text:
        `A shopper searched Kapruka.com for "${term}". Below are ${batch.length} product results, ` +
        'each with its photo and title. Score how relevant each one actually is to that search, ' +
        'looking at the photo as well as the title — text search often pulls in loosely related ' +
        'items (gift hampers, unrelated cosmetics, etc.) that merely mention the word somewhere. ' +
        'Call report_relevancy with one entry per item.',
    },
  ];
  batch.forEach((p, i) => {
    content.push({
      type: 'text',
      text: `Item ${i}: "${p.title || '(no title)'}"${p.price ? ` — ${p.currency || ''} ${p.price}` : ''}`,
    });
    if (p.image) content.push({ type: 'image_url', image_url: { url: p.image } });
  });

  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: REPORT_RELEVANCY_FN }],
      tool_choice: { type: 'function', function: { name: 'report_relevancy' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return batch.map(() => ({ relevancyScore: 0, reasoning: 'no report returned' }));
    const { items } = JSON.parse(call.function.arguments);
    const byIndex = new Map(items.map((it) => [it.index, it]));
    return batch.map((_, i) => byIndex.get(i) || { relevancyScore: 0, reasoning: 'missing from report' });
  } catch (err) {
    return batch.map(() => ({ relevancyScore: 0, reasoning: `error: ${err.message}` }));
  }
}

async function scoreRelevancy(term, products, { log = () => {} } = {}) {
  const batches = [];
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    batches.push(products.slice(i, i + BATCH_SIZE));
  }
  log(`  scoring ${products.length} products in ${batches.length} vision batch(es)...`);
  const scored = await Promise.all(batches.map((batch) => scoreBatch(term, batch)));

  const merged = products.map((p, i) => {
    const batchIdx = Math.floor(i / BATCH_SIZE);
    const withinIdx = i % BATCH_SIZE;
    const s = scored[batchIdx][withinIdx] || {};
    return { ...p, relevancyScore: s.relevancyScore ?? 0, reasoning: s.reasoning || '' };
  });

  merged.sort((a, b) => b.relevancyScore - a.relevancyScore);
  return merged;
}

// ---------------------------------------------------------------------------
// Output

function termFromUrl(url) {
  const m = String(url).match(/find_online\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : 'results';
}

function toCsv(rows) {
  const header = 'rank,title,relevancyScore,price,currency,url,reasoning';
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r, i) =>
    [i + 1, esc(r.title), r.relevancyScore, r.price ?? '', r.currency ?? '', r.url, esc(r.reasoning)].join(',')
  );
  return [header, ...lines].join('\n');
}

async function writeResults(term, ranked, sourceUrl) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const base = `relevancy-${term.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`;
  const jsonPath = path.join(OUT_DIR, `${base}.json`);
  const csvPath = path.join(OUT_DIR, `${base}.csv`);
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      { term, sourceUrl, generatedAt: new Date().toISOString(), count: ranked.length, products: ranked },
      null,
      2
    )
  );
  await fs.writeFile(csvPath, toCsv(ranked));
  return { jsonPath, csvPath };
}

// ---------------------------------------------------------------------------
// CLI

async function readUrlsFromFile(filePath) {
  const text = await fs.readFile(filePath, 'utf-8');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

async function main() {
  const args = process.argv.slice(2);
  let urls = [];
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1) {
    urls = await readUrlsFromFile(args[fileIdx + 1]);
  } else {
    urls = args.filter((a) => !a.startsWith('--'));
  }

  if (urls.length === 0) {
    console.error(
      'Usage: node src/tools/find-online-relevancy.js <find_online-url> [url2] ...\n' +
        '   or: node src/tools/find-online-relevancy.js --file urls.txt'
    );
    process.exit(1);
  }

  for (const url of urls) {
    const term = termFromUrl(url);
    console.log(`\n=== ${term} (${url}) ===`);
    const products = await collectProducts(url, { log: console.log });
    if (products.length === 0) {
      console.log('  no products found, skipping');
      continue;
    }
    const ranked = await scoreRelevancy(term, products, { log: console.log });
    const { jsonPath, csvPath } = await writeResults(term, ranked, url);
    console.log(`  wrote ${jsonPath}`);
    console.log(`  wrote ${csvPath}`);
    console.log('  top 10 by relevancy:');
    ranked.slice(0, 10).forEach((p, i) => {
      console.log(`   ${i + 1}. [${p.relevancyScore}] ${p.title} — ${p.url}`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
