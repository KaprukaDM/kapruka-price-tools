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

import OpenAI from 'openai';
import { cleanQuery } from './serp.js';
import { index } from './compare/matcher.js';
import { scoreCandidate, MIN_INTERSECTION, isAccessoryListing, isAccessoryWord } from './compare/audit-scoring.js';

// A long, SEO-stuffed product name ("Zootopia Bunny Kids Toothbrush 9cm To
// 12cm Retractable Travel Toothbrush With Cute Cover") makes a poor Daraz
// search string as-is — the heuristic queryVariations() below (drop
// first/last word, brand-only, ...) was built for short branded names
// ("Axor Apex Helmet") and doesn't know which of a dozen words is the
// actual product noun. Ask the model to distill the core searchable
// identity first (main product type + the one or two most distinctive
// descriptive words), and try that ahead of the heuristic chain — cheap
// (one small structured-output call per checker search), same OpenAI
// pattern as matcher.js's scoreIdentity/scoreMatch.
const MODEL = process.env.MATCH_MODEL || 'gpt-4o-mini';
let client = null;
function getClient() {
  if (!client) client = new OpenAI();
  return client;
}
const KEYWORDS_FN = {
  name: 'report_search_keywords',
  description: 'Report the single best short search phrase to find this product on a marketplace.',
  parameters: {
    type: 'object',
    properties: {
      keywords: {
        type: 'string',
        description:
          'EXACTLY ONE search phrase, 2-4 words, plain text with NO commas and no alternatives — ' +
          'not a list of options. The core product type (usually the LAST noun in the name, e.g. ' +
          '"toothbrush", "helmet") plus its single most distinctive descriptive word (character/' +
          'theme/brand — usually the FIRST word). Drop exact measurements, sizes, colours, ' +
          'quantities, and generic marketing filler ("retractable", "travel", "with cute cover", ' +
          '"portable", "premium"). Example: "Zootopia Bunny Kids Toothbrush 9cm To 12cm ' +
          'Retractable Travel Toothbrush With Cute Cover" -> "zootopia kids toothbrush" ' +
          '(NOT "zootopia bunny kids toothbrush, retractable travel toothbrush, cute cover").',
      },
    },
    required: ['keywords'],
    additionalProperties: false,
  },
};

async function extractSearchKeywords(productName) {
  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{
        role: 'user',
        content: `Distill the single best marketplace search phrase for this product name:\n\n"${productName}"\n\nCall report_search_keywords.`,
      }],
      tools: [{ type: 'function', function: KEYWORDS_FN }],
      tool_choice: { type: 'function', function: { name: 'report_search_keywords' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return null;
    const { keywords } = JSON.parse(call.function.arguments);
    if (!keywords) return null;
    // Defensive cleanup regardless of what the model actually returned: only
    // the first comma/pipe-separated segment (in case it ignored "exactly
    // one phrase"), capped to 5 words.
    const cleaned = keywords.split(/[,|]/)[0].trim().split(/\s+/).slice(0, 5).join(' ');
    return cleaned || null;
  } catch {
    return null; // best-effort — the heuristic chain below still runs either way
  }
}

// Identity judge for the AI-review fallback (see searchDaraz()). Deliberately
// NOT matcher.js's scoreIdentity() — that one is tuned for the general
// web-search path, which treats a differing model qualifier as an acceptable
// "partial match" (its own prompt: "Redmi 9" vs "Redmi 9 Lite" scores ~55-70,
// isSameModel=true). That leniency is wrong here: caught live, it let a
// "Samsung Galaxy A15" query accept "Samsung Galaxy A05s"/"A06" listings as
// confident (status 'ok') matches — a different phone at a different price,
// not a variant of the same one. A marketplace price lookup needs the
// opposite bias from general identity confirmation: lenient about wording
// for generic/descriptive products (toys, toothbrushes — no model number to
// disagree on), but a HARD reject the moment two comparable model
// numbers/codes actually differ.
const MARKETPLACE_FN = {
  name: 'report_marketplace_match',
  description: 'Report whether this marketplace listing is genuinely the same product the user searched for.',
  parameters: {
    type: 'object',
    properties: {
      matchRate: {
        type: 'integer',
        description: 'Confidence 0-100 that the listing is the SAME product as the query.',
      },
      isSameProduct: { type: 'boolean' },
      reasoning: { type: 'string', description: 'One sentence justifying the verdict.' },
    },
    required: ['matchRate', 'isSameProduct', 'reasoning'],
    additionalProperties: false,
  },
};

async function scoreMarketplaceIdentity(query, candidateTitle) {
  const content =
    `Decide whether this marketplace listing is the SAME product as the user's query.\n\n` +
    `== USER QUERY ==\nName: ${query.name}\nDescription: ${query.description || '(none)'}\n\n` +
    `== LISTING TITLE ==\n${candidateTitle}\n\n` +
    `Rules:\n` +
    `- For a GENERIC/descriptive product with no model number or code (a toy, toothbrush, kitchen item, ` +
    `clothing item, etc.), be LENIENT: match on the core product/theme/character, ignore wording, size, ` +
    `colour, and minor descriptive differences.\n` +
    `- For a product identified by a MODEL NUMBER OR CODE (a phone, laptop, appliance, electronics model — ` +
    `e.g. "A15", "iPhone 15", "RTX 4060", "WF-1000XM5"), that number/code is the product's identity, NOT a ` +
    `qualifier to be lenient about. A DIFFERENT model number/code is a DIFFERENT product at a DIFFERENT ` +
    `price, even from the exact same brand and product line (e.g. "Galaxy A15" and "Galaxy A05s" or ` +
    `"Galaxy A06" are DIFFERENT phones — matchRate below 20, isSameProduct false). Only accept a match when ` +
    `the SAME model number/code appears in both, or the query gives no model number/code at all.\n` +
    `- The listing title being longer, SEO-stuffed, or worded differently is fine as long as the above holds.\n` +
    `Call report_marketplace_match.`;
  try {
    const res = await getClient().chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content }],
      tools: [{ type: 'function', function: MARKETPLACE_FN }],
      tool_choice: { type: 'function', function: { name: 'report_marketplace_match' } },
    });
    const call = res.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) return { matchRate: 0, isSameProduct: false, reasoning: 'no match report' };
    return JSON.parse(call.function.arguments);
  } catch (err) {
    return { matchRate: 0, isSameProduct: false, reasoning: err.message };
  }
}

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
//
// This silently returned null on every non-JSON/non-ok response with no
// trace anywhere — meaning "Daraz doesn't have this" and "Daraz blocked/
// rate-limited this request" were indistinguishable from the outside,
// which took a long back-and-forth to even narrow down once. Log the
// distinguishing case (got a response, but not usable JSON) so it shows up
// in server logs instead of vanishing.
async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: HEADERS });
  } catch (err) {
    console.warn(`[daraz] fetch failed for ${url}: ${err.message}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[daraz] non-OK status ${res.status} for ${url}`);
    return null;
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    // A /tag/ URL serving HTML just means that tag doesn't exist — routine,
    // happens on most long/specific queries (see comment above), not worth
    // logging. The /catalog/ search endpoint doing the same is the real
    // signal (Daraz blocking/rate-limiting/challenge-paging the request).
    if (!url.includes('/tag/')) {
      console.warn(`[daraz] unexpected content-type "${contentType}" for ${url} (likely blocked/rate-limited/challenge page)`);
    }
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    console.warn(`[daraz] JSON parse failed for ${url}: ${err.message}`);
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
    // often carry different pricing/availability/delivery time than a local
    // seller — kept in the results (rather than dropped, as before) but
    // flagged so the checker can badge them, since they're still a real,
    // often cheaper, price point worth showing.
    const location = String(x.location || '').trim().toLowerCase();
    const image = x.image || x.mainImage || '';
    out.push({
      name,
      url: fixUrl(x.productUrl || x.itemUrl || ''),
      price: cleanPrice(x.price ?? x.priceShow),
      image: image.startsWith('//') ? `https:${image}` : image,
      seller: x.sellerName || x.shopName || '',
      overseas: location === 'overseas',
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
  // "Brand + last word" assumes the last word names the product's own
  // category ("Axor Apex Helmet" -> "axor helmet") — but a long descriptive
  // title often ends on an accessory word describing the product's OWN
  // feature ("... Retractable Travel Toothbrush With Cute Cover"), and
  // searching that on a marketplace mostly surfaces phone cases/covers for
  // an unrelated device, not the queried product. Skip anchoring on it.
  const lastIsAccessory = w.length && isAccessoryWord(w[w.length - 1]);
  if (w.length >= 3) {
    if (!lastIsAccessory) variations.push([w[0], w[w.length - 1]].join(' ')); // brand + category
    variations.push(w.slice(0, -1).join(' ')); // drop trailing word
    variations.push(w.slice(1).join(' ')); // drop leading word
  }
  if (w.length >= 4 && !lastIsAccessory) {
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
// brand/category more generally — "Axor helmet"), this produces a shortlist
// worth reviewing instead of giving up. It's a cheap PRE-filter only — the
// real accept/reject decision for this path is the AI identity review in
// searchDaraz() below (scoreMarketplaceIdentity()), not this function. Still gated:
// requires the same minimum shared-token floor scoreCandidate() itself uses
// (MIN_INTERSECTION), so the AI isn't wasted reviewing totally unrelated
// junk. Also excluded here for the same reason scoreCandidate() rejects it
// outright: a search for a device pools in every accessory listing for it
// too (a case/cover/charger/shell title always contains the device's own
// name), and without this a search for "iPhone 15" that finds no genuine
// phone listing pools in phone CASES for the AI to review — cheaper and
// cleaner to rule those out here.
function closestMatches(qIndexed, pool, limit) {
  const scored = [];
  for (const c of index(pool, false)) {
    if (isAccessoryListing(c._tokens)) continue;
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
const TARGET_MATCHES = 8; // stop trying more variations once we have this many
const MAX_RESULTS = 15;
const AI_REVIEW_LIMIT = 12; // cap on AI identity-review calls per fallback search
const AI_MATCH_THRESHOLD = 30; // mirrors pipeline.js's MATCH_THRESHOLD for the 'ok' vs 'low_confidence' cutoff

/**
 * Look up `productName` directly on Daraz: try the literal query plus a
 * handful of broadening variations (see queryVariations()) against Daraz's
 * tag pages / catalogue search, pooling every candidate across variations
 * and scoring each one against the ORIGINAL query with the same
 * identity-matching logic the catalogue-fallback path uses
 * (index() + scoreCandidate()). Stops early once enough matches are found.
 * If nothing clears that heuristic bar, a shortlist of same-brand/category
 * candidates (closestMatches()) gets a second pass through an AI identity
 * judge (scoreMarketplaceIdentity()) instead of being shown blanket-labelled
 * "approximate" — genuinely unrelated listings AND mismatched model
 * numbers/codes get dropped there rather than surfaced with a generic
 * disclaimer.
 * Returns an array of up to MAX_RESULTS matches in the standard pipeline
 * result shape (empty array if nothing scored as a plausible match, AI or
 * otherwise; a single error-flagged entry if every variation's request
 * failed outright).
 */
export async function searchDaraz(productName, description = '') {
  const base = { site: 'Daraz', domain: 'daraz.lk' };
  const [qIndexed] = index([{ name: productName, url: 'query' }], false);
  // A tight title-length cap used to sit here to guard against an open
  // marketplace's SEO-stuffed titles ("JBL Tune 700BT Tune 510BT Tune
  // 760BT..." trivially containing a short "JBL Tune 710BT" query). But
  // scoreCandidate() itself already rejects exactly that case today
  // (unmatchedDistinctiveToken requires the query's OWN model number/word
  // to appear verbatim, not just any overlap) -- and the old 2x+2 cap was
  // rejecting genuinely matching listings by the dozen in categories that
  // just write long titles by habit (hair accessories, toys, ...: a
  // 4-token "Girls Hair Bands 30pcs" query against a completely on-topic
  // but 16-token real listing title). Keep only a generous backstop against
  // pathological spam, not a routine filter.
  const maxTokens = Math.max(20, qIndexed._tokens.size * 5);

  const seenUrls = new Set();
  const pool = [];
  let anySucceeded = false;
  let accepted = [];

  // Try the AI-distilled core keywords first (best for long/SEO-stuffed
  // names — see extractSearchKeywords() above), then the heuristic chain
  // (which already includes the literal full query) as broadening/fallback.
  const aiKeywords = await extractSearchKeywords(productName);
  const seenVariations = new Set();
  const variations = [aiKeywords, ...queryVariations(productName)].filter((v) => {
    const key = (v || '').trim().toLowerCase();
    if (!key || seenVariations.has(key)) return false;
    seenVariations.add(key);
    return true;
  });

  for (const variation of variations.slice(0, MAX_VARIATIONS + 1)) {
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

  console.log(`[daraz] "${productName}" -> ${variations.length} variation(s) tried, pool=${pool.length}, accepted=${accepted.length}`);

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
      flags: c.overseas ? ['marketplace', 'overseas'] : ['marketplace'],
      overseas: !!c.overseas,
      status: Math.round(sc.overlap * 100) < 50 ? 'low_confidence' : c.price == null ? 'price_not_found' : 'ok',
    }));
  }

  // No confident match anywhere in the pool via the token-heuristic scorer.
  // closestMatches() still does its cheap pre-filtering first (accessory
  // words, minimum shared-token floor) to get a shortlist worth spending API
  // calls on -- then each shortlisted candidate goes through
  // scoreMarketplaceIdentity() (above), instead of blanket-labelling every
  // same-brand/category listing "approximate" and showing it regardless.
  // This is what actually eliminates genuinely unrelated listings (e.g. a
  // phone-case search hit that slips past the accessory-word list) rather
  // than just relabelling them all as unverified.
  const shortlist = closestMatches(qIndexed, pool, AI_REVIEW_LIMIT);
  if (!shortlist.length) return [];

  const reviewed = await Promise.all(
    shortlist.map(async (c) => {
      const identity = await scoreMarketplaceIdentity({ name: productName, description }, c.name);
      return { c, identity };
    }),
  );

  if (process.env.DEBUG_DARAZ_AI) {
    for (const r of reviewed) console.log(`[daraz][debug] ${r.identity.isSameProduct ? 'KEEP' : 'drop'} (${r.identity.matchRate}) "${r.c.name}" -- ${r.identity.reasoning}`);
  }
  const kept = reviewed.filter((r) => r.identity.isSameProduct);
  console.log(`[daraz] AI review: ${shortlist.length} candidate(s) shortlisted, ${kept.length} kept as genuine matches`);
  if (!kept.length) return [];

  kept.sort((a, b) => (b.identity.matchRate || 0) - (a.identity.matchRate || 0));
  return kept.slice(0, MAX_RESULTS).map(({ c, identity }) => ({
    ...base,
    title: c.name,
    url: c.url,
    image: c.image || null,
    matchRate: identity.matchRate,
    price: c.price,
    currency: 'LKR',
    priceContext: c.seller ? `sold by ${c.seller}` : '',
    reasoning: identity.reasoning || 'AI-reviewed marketplace match — verify before relying on this price.',
    flags: c.overseas ? ['marketplace', 'ai_reviewed', 'overseas'] : ['marketplace', 'ai_reviewed'],
    overseas: !!c.overseas,
    status: (identity.matchRate ?? 0) < AI_MATCH_THRESHOLD ? 'low_confidence' : c.price == null ? 'price_not_found' : 'ok',
  }));
}
