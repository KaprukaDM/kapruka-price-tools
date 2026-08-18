// Pulls product cards off a Kapruka "find_online" listing page (and its
// pagination), reading the JSON-LD <script> block Kapruka embeds per product
// card rather than guessing at CSS classes. Reliable link/title/image/price
// extraction — no vision needed for this part.

import * as cheerio from 'cheerio';

const PRODUCT_LIMIT_DEFAULT = 60;
const PAGE_SAFETY_CAP = 8; // hard stop even if the site keeps returning "new" pages

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

// The listing page's "See More Products" button carries the exact URL
// template Kapruka's own frontend uses for pagination, e.g.
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

export function termFromUrl(url) {
  const m = String(url).match(/find_online\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : 'results';
}

/**
 * Collect up to `limit` products from a Kapruka find_online URL, following
 * its own pagination (~30 products/page) until the limit is hit, a page
 * yields no new products, or the safety cap is reached.
 */
export async function collectProducts(listingUrl, { limit = PRODUCT_LIMIT_DEFAULT, log = () => {} } = {}) {
  const seen = new Map(); // url -> product
  const firstHtml = await fetchListingHtml(listingUrl);
  for (const p of parseListingProducts(firstHtml)) {
    if (p.url) seen.set(p.url, p);
  }
  log(`page 1: ${seen.size} products`);

  const template = findPaginationTemplate(firstHtml, listingUrl);
  let page = 2;
  while (template && seen.size < limit && page <= PAGE_SAFETY_CAP) {
    const pageUrl = withPage(template, page);
    let html;
    try {
      html = await fetchListingHtml(pageUrl, listingUrl);
    } catch (err) {
      log(`page ${page}: fetch failed (${err.message}), stopping`);
      break;
    }
    const before = seen.size;
    for (const p of parseListingProducts(html)) {
      if (p.url && !seen.has(p.url)) seen.set(p.url, p);
    }
    const added = seen.size - before;
    log(`page ${page}: +${added} new (total ${seen.size})`);
    if (added === 0) break; // ran out of results
    page += 1;
  }

  return Array.from(seen.values()).slice(0, limit);
}
