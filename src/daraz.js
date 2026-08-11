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
// indexed it. The best-scoring results become extra rows in the checker,
// clearly flagged as marketplace listings.
//
// Two lookup paths per query, tried in order:
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
//
// A single literal query often has no matching tag/listing (e.g. "Axor Apex
// Helmet" — Daraz doesn't stock that exact model, but does stock a plain
// "Axor helmet"). So we don't stop at one query: generate a handful of
// variations (drop the brand, drop the trailing category word, drop the
// middle model word, brand-only) and keep searching — pooling results across
// variations — until we've collected a few genuine matches or run out of
// variations to try. Precision doesn't loosen as the search broadens: every
// candidate, from whichever variation surfaced it, is still scored against
// the ORIGINAL full query, so a broader variation only adds recall, never a
// weaker match bar.

import { cleanQuery } from './serp.js';
import { index } from './compare/matcher.js';
import { scoreCandidate, MIN_INTERSECTION } from './compare/audit-scoring.js';

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

function words(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// Build a prioritized list of query variations to try, most-specific first:
// the literal query, then brand+category with the middle model word(s)
// dropped, then drop-last/drop-first, then brand alone as a last resort.
// "Axor Apex Helmet" -> ["axor apex helmet", "axor helmet", "axor apex",
// "apex helmet", "axor"].
function queryVariations(name) {
  const w = words(name);
  const variations = [String(name || '').trim()];
  if (w.length >= 3) {
    variations.push([w[0], w[w.length - 1]].join(' ')); // brand + category
    variations.push(w.slice(0, -1).join(' ')); // drop trailing word
    variations.push(w.slice(1).join(' ')); // drop leading word
  }
  if (w.length >= 4) {
    variations.push([w[0], w[w.length - 2], w[w.length - 1]].join(' ')); // brand + last two words
  }
  if (w.length >= 2) {
    variations.push(w[0]); // brand alone
  }
  const seen = new Set();
  return variations.filter((v) => {
    const key = v.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// When nothing in the pool scores as a confident match (e.g. Daraz doesn't
// stock the exact model — "Axor Apex Helmet" — but does stock the same
// brand/category more generally — "Axor helmet"), surface the closest
// listings instead of reporting nothing, so the search visibly did the
// broadening it was asked to rather than going quiet. Still gated: requires
// the same minimum shared-token floor scoreCandidate() itself uses
// (MIN_INTERSECTION), so this can't degrade into "any random helmet counts"
// — and every result from this path is explicitly flagged approximate,
// never presented as if it were the exact product.
function closestMatches(qIndexed, pool, limit) {
  const scored = [];
  for (const c of index(pool, false)) {
    let shared = 0;
    for (const t of qIndexed._tokens) if (c._tokens.has(t)) shared++;
    if (shared < MIN_INTERSECTION) continue;
    scored.push({ c, shared });
  }
  scored.sort((a, b) => b.shared - a.shared || (a.c.price ?? Infinity) - (b.c.price ?? Infinity));
  return scored.slice(0, limit).map((s) => s.c);
}

async function fetchCandidates(query) {
  const slug = toTagSlug(query);
  let items = slug ? parseItems(await fetchJson(tagUrl(slug))) : [];
  if (!items.length) items = parseItems(await fetchJson(searchUrl(cleanQuery(query))));
  return items;
}

const MAX_VARIATIONS = 5;
const TARGET_MATCHES = 3; // stop trying more variations once we have this many
const MAX_RESULTS = 5;

/**
 * Look up `productName` directly on Daraz: try the literal query plus a
 * handful of broadening variations (see queryVariations()) against Daraz's
 * tag pages / catalogue search, pooling every candidate across variations
 * and scoring each one against the ORIGINAL query with the same
 * identity-matching logic the catalogue-fallback path uses
 * (index() + scoreCandidate()). Stops early once enough matches are found.
 * Returns an array of up to MAX_RESULTS matches in the standard pipeline
 * result shape (empty array if nothing scored as a plausible match; a
 * single error-flagged entry if every variation's request failed).
 */
export async function searchDaraz(productName) {
  const base = { site: 'Daraz', domain: 'daraz.lk' };
  const [qIndexed] = index([{ name: productName, url: 'query' }], false);
  // scoreCandidate()'s no-code fallback path accepts any candidate that
  // merely CONTAINS every query token — fine for curated single-product
  // catalogues (its usual callers), but an open marketplace is full of
  // accessory listings that stuff several device names into one SEO title
  // ("JBL Tune 700BT Tune 510BT Tune 760BT..." for a bluetooth-headphone
  // case, or "...Screen Protector" naming a dozen phone models) — those
  // trivially contain a short device-name query and would otherwise score
  // a 100% match. Reject candidates whose title is disproportionately
  // longer than the ORIGINAL query; a genuine match for a short model-name
  // query doesn't need to double in length to describe the same product.
  const maxTokens = qIndexed._tokens.size * 2 + 2;

  const seenUrls = new Set();
  const pool = [];
  let anySucceeded = false;
  let accepted = [];

  for (const variation of queryVariations(productName).slice(0, MAX_VARIATIONS)) {
    try {
      const items = await fetchCandidates(variation);
      anySucceeded = true;
      for (const it of items) {
        if (!it.url || seenUrls.has(it.url)) continue;
        seenUrls.add(it.url);
        pool.push(it);
      }
    } catch {
      continue; // a network hiccup on one variation shouldn't abort the rest
    }

    accepted = [];
    for (const c of index(pool, false)) {
      if (c._tokens.size > maxTokens) continue;
      const sc = scoreCandidate(qIndexed, c);
      if (sc) accepted.push({ c, sc });
    }
    if (accepted.length >= TARGET_MATCHES) break;
  }

  if (!anySucceeded && !pool.length) {
    return [{ ...base, status: 'error', flags: ['daraz_failed'], note: 'Daraz did not respond to any query variation.' }];
  }

  if (accepted.length) {
    accepted.sort((a, b) => b.sc.value - a.sc.value);
    return accepted.slice(0, MAX_RESULTS).map(({ c, sc }) => ({
      ...base,
      title: c.name,
      url: c.url,
      image: c.image || null,
      matchRate: Math.round(sc.overlap * 100),
      price: c.price,
      currency: 'LKR',
      priceContext: c.seller ? `sold by ${c.seller}` : '',
      reasoning: 'Matched from a live search on Daraz.lk — a third-party marketplace listing, verify the seller before buying.',
      flags: ['marketplace'],
      status: Math.round(sc.overlap * 100) < 50 ? 'low_confidence' : c.price == null ? 'price_not_found' : 'ok',
    }));
  }

  // No confident match anywhere in the pool — fall back to the closest
  // same-brand/category listings rather than reporting nothing.
  const approx = closestMatches(qIndexed, pool, 2);
  return approx.map((c) => ({
    ...base,
    title: c.name,
    url: c.url,
    image: c.image || null,
    matchRate: null,
    price: c.price,
    currency: 'LKR',
    priceContext: c.seller ? `sold by ${c.seller}` : '',
    reasoning: `No exact match for "${productName}" on Daraz — this is the closest same-brand/category listing found, not necessarily the same model. Verify before relying on this price.`,
    flags: ['marketplace', 'approximate_match'],
    status: 'low_confidence',
  }));
}
