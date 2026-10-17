// Photo check for the partner price comparison. matchCatalogs() pairs
// products on their titles alone; this second pass looks at the product
// photos to
//   · confirm a "needs review" title match (or one with a suspicious price
//     gap) — and undo it when the photos show two different products,
//   · rescue a pair the titles alone couldn't confirm ("Ivory Groove Shirt"
//     on Kapruka vs "Groove Unisex Shirt - Ivory" on the partner's site).
// Colour variants count as the SAME product: a partner photographs one
// colourway and Kapruka lists another, at the same price.
//
// Two tiers, cheapest first:
//   1. same image FILE on both sides. Kapruka very often shows the
//      partner's own photo (e.g. JoeY Clothing's cdn.shopify.com file), which
//      settles it for free.
//   2. a vision model comparing the two photos, for pairs that need it, up to
//      IMAGE_MATCH_MAX_CHECKS new calls per partner per run. Verdicts are
//      kept in the comparison payload (imageChecks) and reused next run, so a
//      pair is only ever paid for once while its photos stay the same.

import OpenAI from 'openai';
import { index, jaccard, priceComparison, matchedRow } from './matcher.js';
import { specsConflict } from './normalize.js';

const MODEL = process.env.IMAGE_MATCH_MODEL || 'gpt-4o-mini';
const MAX_CHECKS = Number(process.env.IMAGE_MATCH_MAX_CHECKS || 60);
const DISABLED = process.env.DISABLE_IMAGE_MATCH === '1';
const CONCURRENCY = 4;
// A matched pair whose prices differ by this much is worth a look even when
// the titles agree strongly — a different pack size or model is the usual
// reason for a gap this big.
const SUSPICIOUS_PRICE_GAP_PCT = 40;
// Loosest title overlap a pair may have and still be put to the photo check
// as a possible match the titles missed.
const RESCUE_MIN_JACCARD = 0.25;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const IMAGE_MAX_BYTES = 4 * 1024 * 1024;

let client = null;
function getClient() {
  if (!client) client = new OpenAI();
  return client;
}

// "…/files/S9A5154copy.jpg?v=17&width=330" and "…/S9A5154copy_600x.jpg" ->
// "s9a5154copy": the file's identity without size variants or CDN params.
const GENERIC_IMAGE_NAMES = /^(placeholder|no[-_]?image|default|image|img|photo|logo|woocommerce[-_]placeholder)$/;
export function imageKey(url) {
  if (!url) return null;
  let file;
  try {
    file = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch {
    return null;
  }
  const key = file
    .toLowerCase()
    .replace(/\.(jpe?g|png|webp|gif|avif)$/, '')
    .replace(/[-_](\d+x\d*|x\d+|small|medium|large|grande|thumb|thumbnail|compact|master|scaled)$/g, '')
    .replace(/-\d+x\d+$/, '');
  if (key.length < 6 || GENERIC_IMAGE_NAMES.test(key) || /^\d{1,6}$/.test(key)) return null;
  return key;
}

function sameImageFile(a, b) {
  const ka = imageKey(a);
  return Boolean(ka) && ka === imageKey(b);
}

// Ask the CDN for a small rendition where it supports it — the model only
// needs ~512px, and a full-size product shot can be several MB.
function smallerImageUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('cdn.shopify.com') || u.pathname.includes('/cdn/shop/')) {
      u.searchParams.set('width', '512');
      return u.toString();
    }
  } catch {}
  return url;
}

const SUPPORTED_TYPES = /^image\/(jpeg|png|webp|gif)/;
async function imageDataUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(smallerImageUrl(url), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`image HTTP ${res.status}`);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!SUPPORTED_TYPES.test(type)) throw new Error(`unsupported image type ${type || 'unknown'}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > IMAGE_MAX_BYTES) throw new Error('image too large');
    return `data:${type};base64,${buf.toString('base64')}`;
  } finally {
    clearTimeout(timer);
  }
}

const VERDICT_FN = {
  name: 'report_photo_match',
  description: 'Report whether two product photos show the same product.',
  parameters: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['same', 'different', 'unsure'],
        description:
          '"same" if both photos show the same product (same item/model/design), even in a different colour. ' +
          '"different" if they are different products: a different model, design, shape, pattern, size/pack ' +
          'count or flavour. "unsure" if a photo is unusable (logo, placeholder, too blurry) or it truly cannot be told.',
      },
      colourVariantOnly: {
        type: 'boolean',
        description: 'True if the only difference between the two is the colour/colourway.',
      },
      sizeOrQuantityDiffers: {
        type: 'boolean',
        description:
          'True if the photos or titles show a different size, weight, volume, number of pieces/items, ' +
          'or a single item vs a set/arrangement/bundle. False when one title simply does not state a size.',
      },
      reason: { type: 'string', description: 'One short sentence.' },
    },
    required: ['verdict', 'colourVariantOnly', 'sizeOrQuantityDiffers', 'reason'],
    additionalProperties: false,
  },
};

async function askModel(pair) {
  const [kImg, pImg] = await Promise.all([imageDataUrl(pair.kaprukaImage), imageDataUrl(pair.partnerImage)]);
  const text =
    'Two shop listings, possibly of the same product.\n' +
    `Photo 1 — Kapruka: "${pair.kaprukaName}"\n` +
    `Photo 2 — the brand's own website: "${pair.partnerName}"\n\n` +
    'Do the photos show the SAME product? Judge mainly from the photos; the titles may word the same product differently. Rules:\n' +
    '- A different COLOUR or colourway of the same item counts as the same product.\n' +
    '- Ignore background, angle, lighting, model/mannequin, watermarks, cropping and photo quality.\n' +
    '- A different design, print, shape, model or flavour is a different product.\n' +
    '- A different size, weight, volume or piece count is a different product, and so is a single item vs a set, ' +
    'bundle or arrangement of it. Only a title that leaves the size out entirely is not a size difference.\n' +
    '- Two items that are merely similar (same category, same style) are NOT the same product.\n' +
    'Call report_photo_match.';
  const res = await getClient().chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: kImg, detail: 'low' } },
          { type: 'image_url', image_url: { url: pImg, detail: 'low' } },
        ],
      },
    ],
    tools: [{ type: 'function', function: VERDICT_FN }],
    tool_choice: { type: 'function', function: { name: 'report_photo_match' } },
  });
  const call = res.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error('no verdict returned');
  return JSON.parse(call.function.arguments);
}

// Bump VERDICT_VERSION whenever the question put to the model changes, so
// verdicts cached under the old wording are asked again.
const VERDICT_VERSION = 2;
function pairKey(kImg, pImg) {
  return `v${VERDICT_VERSION}|${kImg}|${pImg}`;
}

// A photo-only match (titles too different to pair them) also has to be in
// the same price range: a partner's own price is rarely more than double or
// less than half of Kapruka's for the same item.
const RESCUE_MAX_PRICE_RATIO = 2;
function plausiblePrices(a, b) {
  if (a == null || b == null || a <= 0 || b <= 0) return true;
  return Math.max(a, b) / Math.min(a, b) <= RESCUE_MAX_PRICE_RATIO;
}

async function runPool(items, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) await worker(items[i++]);
    }),
  );
}

/**
 * Mutates `result` (matchCatalogs() output) in place and returns
 * { stats, imageChecks } — imageChecks is the verdict cache to store with the
 * payload so the next run can reuse it.
 */
export async function verifyWithImages(result, { previousChecks = [], log = () => {} } = {}) {
  const stats = { sameFile: 0, modelChecks: 0, cached: 0, confirmed: 0, rejected: 0, rescued: 0, failed: 0 };
  const cache = new Map(previousChecks.map((c) => [c.key, c]));
  const used = new Map(); // verdicts consulted this run -> carried into the payload
  result.imageRejected = [];

  // ---- Tier 1: same image file ------------------------------------------
  for (const m of result.matched) {
    if (sameImageFile(m.kaprukaImage, m.partnerImage)) {
      m.imageMatch = 'same_file';
      if (m.confidence !== 'high') m.confidence = 'high';
      stats.sameFile++;
    }
  }
  const kIdx = index(result.onlyKapruka, false);
  const pIdx = index(result.onlyPartner, false);
  const partnerByImage = new Map();
  for (const p of pIdx) {
    const key = imageKey(p.image);
    if (!key) continue;
    // A photo shared by several partner listings (sizes of one item) can't
    // say which of them Kapruka's listing is.
    partnerByImage.set(key, partnerByImage.has(key) ? null : p);
  }
  const rescuedK = new Set();
  const rescuedP = new Set();
  for (const k of kIdx) {
    const p = partnerByImage.get(imageKey(k.image));
    if (!p || rescuedP.has(p) || specsConflict(k._specs, p._specs) || !plausiblePrices(k.price, p.price)) continue;
    const jac = jaccard(k._tokens, p._tokens);
    if (jac < 0.15) continue;
    rescuedK.add(k);
    rescuedP.add(p);
    result.matched.push(rescuedRow(k, p, jac, 'same_file'));
    stats.sameFile++;
    stats.rescued++;
  }

  // ---- Tier 2: vision model ---------------------------------------------
  const canAsk = !DISABLED && Boolean(process.env.OPENAI_API_KEY);
  const queue = [];
  for (const m of result.matched) {
    if (m.imageMatch || !m.kaprukaImage || !m.partnerImage) continue;
    const suspicious = m.pct != null && Math.abs(m.pct) >= SUSPICIOUS_PRICE_GAP_PCT;
    if (m.confidence === 'high' && !suspicious) continue;
    queue.push({ kind: 'verify', row: m, kaprukaImage: m.kaprukaImage, partnerImage: m.partnerImage, kaprukaName: m.name, partnerName: m.partnerName, priority: m.confidence === 'high' ? 1 : 0 });
  }
  // Possible matches the titles missed: each leftover Kapruka product's
  // closest leftover partner product, if the titles overlap at all.
  const looseCandidates = [];
  for (const k of kIdx) {
    if (rescuedK.has(k) || !k.image) continue;
    let best = null;
    for (const p of pIdx) {
      if (rescuedP.has(p) || !p.image || specsConflict(k._specs, p._specs) || !plausiblePrices(k.price, p.price)) continue;
      const jac = jaccard(k._tokens, p._tokens);
      if (jac >= RESCUE_MIN_JACCARD && (!best || jac > best.jac)) best = { p, jac };
    }
    if (best) looseCandidates.push({ k, ...best });
  }
  looseCandidates.sort((a, b) => b.jac - a.jac);
  const claimedP = new Set();
  for (const c of looseCandidates) {
    if (claimedP.has(c.p)) continue;
    claimedP.add(c.p);
    queue.push({ kind: 'rescue', k: c.k, p: c.p, jac: c.jac, kaprukaImage: c.k.image, partnerImage: c.p.image, kaprukaName: c.k.name, partnerName: c.p.name, priority: 2 });
  }
  queue.sort((a, b) => a.priority - b.priority);

  let budget = canAsk ? MAX_CHECKS : 0;
  const decided = [];
  await runPool(queue, async (item) => {
    const key = pairKey(item.kaprukaImage, item.partnerImage);
    let v = cache.get(key);
    if (v) {
      stats.cached++;
    } else {
      if (budget <= 0) return;
      budget--;
      try {
        const r = await askModel(item);
        // A size/quantity difference overrides a "same" (the model has been
        // seen calling a 4-piece set the same as one piece).
        const verdict = r.verdict === 'same' && r.sizeOrQuantityDiffers ? 'different' : r.verdict;
        v = { key, verdict, colourOnly: Boolean(r.colourVariantOnly), reason: r.reason || '', at: new Date().toISOString() };
        cache.set(key, v);
        stats.modelChecks++;
      } catch (err) {
        stats.failed++;
        log(`  image check failed for "${item.kaprukaName}": ${err.message}`);
        return;
      }
    }
    used.set(key, v);
    decided.push({ item, v });
  });

  const rejectedRows = new Set();
  for (const { item, v } of decided) {
    const tag = v.colourOnly ? 'same_colour_variant' : 'same';
    if (item.kind === 'verify') {
      const m = item.row;
      m.imageReason = v.reason;
      if (v.verdict === 'same') {
        m.imageMatch = tag;
        m.confidence = 'high';
        stats.confirmed++;
      } else if (v.verdict === 'different') {
        rejectedRows.add(m);
        result.imageRejected.push({ name: m.name, kaprukaUrl: m.kaprukaUrl, partnerName: m.partnerName, partnerUrl: m.partnerUrl, reason: v.reason });
        stats.rejected++;
      } else {
        m.imageMatch = 'unsure';
      }
    } else if (v.verdict === 'same') {
      rescuedK.add(item.k);
      rescuedP.add(item.p);
      const row = rescuedRow(item.k, item.p, item.jac, tag);
      row.imageReason = v.reason;
      result.matched.push(row);
      stats.rescued++;
    }
  }

  // Undo photo-rejected matches: both products go back to their "only on"
  // lists, exactly as if the titles had never paired them.
  if (rejectedRows.size) {
    result.matched = result.matched.filter((m) => !rejectedRows.has(m));
    for (const m of rejectedRows) {
      result.onlyKapruka.push({ name: m.name, price: m.kaprukaPrice, url: m.kaprukaUrl, inStock: m.kaprukaInStock, image: m.kaprukaImage });
      result.onlyPartner.push({
        name: m.partnerName, sku: m.partnerSku, price: m.partnerPrice, url: m.partnerUrl, brand: m.partnerBrand,
        category: m.partnerCategory, regularPrice: m.partnerRegularPrice, inStock: m.partnerInStock, image: m.partnerImage,
      });
    }
  }
  if (rescuedK.size) {
    const kUrls = new Set([...rescuedK].map((k) => k.url));
    const pUrls = new Set([...rescuedP].map((p) => p.url));
    result.onlyKapruka = result.onlyKapruka.filter((k) => !kUrls.has(k.url));
    result.onlyPartner = result.onlyPartner.filter((p) => !pUrls.has(p.url));
  }

  return { stats, imageChecks: [...used.values()] };
}

// A pair the titles alone didn't match but the photos did. Kept at "review"
// confidence unless the titles also agree reasonably well.
function rescuedRow(k, p, jac, imageMatch) {
  return {
    ...matchedRow(k, p),
    confidence: jac >= 0.4 ? 'high' : 'medium',
    sharedCodes: 0,
    nameSimilarity: Math.round(jac * 100),
    matchedBy: 'image',
    imageMatch,
    ...priceComparison(k, p),
  };
}
