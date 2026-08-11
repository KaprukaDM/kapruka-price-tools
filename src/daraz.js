// Direct Daraz.lk lookup for the Price Checker.
//
// Daraz is deliberately excluded from the generic SERP-based discovery path
// (see serp.js's DISCOVERY_BLOCKLIST) — its `site:` search results are
// unreliable and a marketplace listing carries heavy third-party-seller
// noise, the same call already made for the chocolates/cosmetics/sports
// audits (see chocolates-audit/site-adapters.js).
//
// Here we take a different path, purpose-built for the checker: query
// Daraz's own AJAX catalogue endpoint directly with the product name (the
// same undocumented JSON feed the site itself uses to populate search-result
// pages — see the standalone daraz_agent.py scraper for the same trick) and
// generate the product link ourselves, rather than relying on Google to have
// indexed it. The best-scoring result becomes a single extra row in the
// checker, clearly flagged as a marketplace listing.
//
// Two lookup paths, tried in order:
//  1) /tag/<slug>/?ajax=true — Daraz's curated tag/category pages (the same
//     URL you land on clicking a tag like daraz.lk/tag/helmet/). These rank
//     noticeably cleaner than raw search: e.g. /tag/axor-helmets/ surfaces
//     genuine Axor helmets at the very top, where the plain catalog search
//     for the same query buries the one relevant result among 40 mostly-
//     irrelevant ones. Slug = the query, lowercased, punctuation stripped,
//     spaces turned into hyphens.
//  2) /catalog/?ajax=true&q=... — the original raw search endpoint, used as
//     a fallback when the tag doesn't exist (Daraz serves an HTML page, not
//     JSON, for an unrecognized tag) or returns nothing.

import { cleanQuery } from './serp.js';
import { index } from './compare/matcher.js';
import { scoreCandidate } from './compare/audit-scoring.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.1',
  Referer: 'https://www.daraz.lk/',
};

const searchUrl = (q) => `https://www.daraz.lk/catalog/?ajax=true&q=${encodeURIComponent(q)}&page=1`;
const tagUrl = (slug) => `https://www.daraz.lk/tag/${slug}/?ajax=true`;

// "Axor Apex Helmet" -> "axor-apex-helmet". Daraz tag slugs are lowercase,
// hyphen-separated, alphanumeric only.
function toTagSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

// A nonexistent tag serves Daraz's normal HTML page (200 OK, not JSON) rather
// than erroring, so JSON-ness is the actual signal for "this tag exists" —
// checking res.ok alone isn't enough.
async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  if (!(res.headers.get('content-type') || '').includes('application/json')) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function fixUrl(href) {
  if (!href) return '';
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return `https://www.daraz.lk${href}`;
  if (!href.startsWith('http')) return `https://www.daraz.lk/${href}`;
  return href;
}

function cleanPrice(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Parse the "listItems" shape returned by Daraz's ajax=true catalogue feed.
// Field names vary slightly by page type (same reason daraz_agent.py tries
// several candidate keys per field), so coalesce across the known aliases.
function parseItems(data) {
  const mods = data?.mods || data?.mainInfo || {};
  const items = mods.listItems || mods.items || [];
  if (!Array.isArray(items)) return [];

  const out = [];
  for (const x of items) {
    const name = x.name || x.productTitle || '';
    if (!name) continue;
    // Foreign-seller ("overseas") listings ship from outside Sri Lanka and
    // often carry different pricing/availability — same filter daraz_agent.py
    // applies.
    const location = String(x.location || '').trim().toLowerCase();
    if (location === 'overseas') continue;
    const image = x.image || x.mainImage || '';
    out.push({
      name,
      url: fixUrl(x.productUrl || x.itemUrl || ''),
      price: cleanPrice(x.price ?? x.priceShow),
      image: image.startsWith('//') ? `https:${image}` : image,
      seller: x.sellerName || x.shopName || '',
    });
  }
  return out;
}

/**
 * Look up `productName` directly on Daraz: search its own AJAX catalogue
 * endpoint, score every result against the query with the same
 * identity-matching logic the catalogue-fallback path uses
 * (index() + scoreCandidate()), and return the best match in the standard
 * pipeline result shape — or a flagged no-match/error result if nothing
 * came back or nothing scored as a plausible match.
 */
export async function searchDaraz(productName) {
  const base = { site: 'Daraz', domain: 'daraz.lk' };
  let items = [];
  try {
    const slug = toTagSlug(productName);
    if (slug) items = parseItems(await fetchJson(tagUrl(slug)));
    if (!items.length) items = parseItems(await fetchJson(searchUrl(cleanQuery(productName))));
  } catch (err) {
    return { ...base, status: 'error', flags: ['daraz_failed'], note: err.message };
  }

  if (!items.length) {
    return { ...base, status: 'no_result', flags: ['no_candidates'] };
  }

  const [qIndexed] = index([{ name: productName, url: 'query' }], false);
  const indexed = index(items, false);
  // scoreCandidate()'s no-code fallback path accepts any candidate that
  // merely CONTAINS every query token — fine for curated single-product
  // catalogues (its usual callers), but an open marketplace is full of
  // accessory listings that stuff several device names into one SEO title
  // ("JBL Tune 700BT Tune 510BT Tune 760BT..." for a bluetooth-headphone
  // case, or "...Screen Protector" naming a dozen phone models) — those
  // trivially contain a short device-name query and would otherwise score
  // a 100% match. Reject candidates whose title is disproportionately
  // longer than the query; a genuine match for a short model-name query
  // doesn't need to double in length to describe the same product.
  const maxTokens = qIndexed._tokens.size * 2 + 2;
  let best = null;
  for (const c of indexed) {
    if (c._tokens.size > maxTokens) continue;
    const sc = scoreCandidate(qIndexed, c);
    if (sc && (!best || sc.value > best.sc.value)) best = { c, sc };
  }
  if (!best) {
    return { ...base, status: 'no_result', flags: ['no_confident_match'] };
  }

  const matchRate = Math.round(best.sc.overlap * 100);
  const price = best.c.price;
  return {
    ...base,
    title: best.c.name,
    url: best.c.url,
    image: best.c.image || null,
    matchRate,
    price,
    currency: 'LKR',
    priceContext: best.c.seller ? `sold by ${best.c.seller}` : '',
    reasoning: 'Matched from a live search on Daraz.lk — a third-party marketplace listing, verify the seller before buying.',
    flags: ['marketplace'],
    status: matchRate < 50 ? 'low_confidence' : price == null ? 'price_not_found' : 'ok',
  };
}
