// One search() function per competitor site, reverse-engineered from each
// site's own live-search/AJAX endpoint (not Google/Serper — see SCRAPER-SETUP.md
// style reasoning: Serper's `site:` operator is blocked on our plan, and
// scraping Google/Bing directly gets CAPTCHA'd immediately from a datacenter
// IP). Every adapter returns the same normalized shape:
//   Promise<Array<{ name: string, url: string, priceLKR: number|null }>>
//
// Sites whose search response doesn't include a price (buyabans.com,
// abansit.lk, cameralk.com) return priceLKR: null — the orchestrator fetches
// the winning matched product's own page for price via fetchPriceFromPage(),
// so only one extra request per product (not per candidate) is paid for that.

import * as cheerio from 'cheerio';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchText(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-LK,en;q=0.9', ...(opts.headers || {}) },
      redirect: 'follow',
      signal: controller.signal,
      ...opts,
    });
    return { ok: res.ok, status: res.status, text: await res.text(), headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// res.headers.get('set-cookie') only ever returns ONE cookie even when the
// server sent several (undici won't comma-join Set-Cookie, since commas are
// legal inside cookie values/expiry dates) — silently dropping the session
// cookie whenever a site sets both a CSRF cookie and a session cookie, which
// breaks every CSRF-flow adapter below. getSetCookie() returns all of them.
function cookieHeader(headers) {
  const all = headers.getSetCookie ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  return all.map((c) => c.split(';')[0]).join('; ');
}

async function fetchJson(url, opts = {}) {
  const { ok, text } = await fetchText(url, opts);
  if (!ok || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// "Rs. 4,250.00" / "LKR 8,764" / "304,000" / "4500" -> 4250 (integer LKR).
function parsePriceLKR(text) {
  if (text == null) return null;
  const m = String(text).match(/[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// WooCommerce Store API price object -> integer LKR.
function wooPrice(p) {
  const price = p?.prices?.price;
  if (price == null) return null;
  const minorUnit = p?.prices?.currency_minor_unit ?? 2;
  const n = Number(price) / 10 ** minorUnit;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function abs(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

// Generic fallback: fetch a product page and pull a price out of JSON-LD
// Product offers or the og/product:price meta tag. Used for adapters whose
// search step doesn't carry a price (only called once, on the winning match).
export async function fetchPriceFromPage(url) {
  try {
    const { ok, text: html } = await fetchText(url);
    if (!ok) return null;
    const blocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of blocks) {
      if (!/"@type"\s*:\s*"Product"/i.test(block)) continue;
      const m = block.match(/"price"\s*:\s*"?([\d.]+)/i);
      if (m) {
        const n = parseFloat(m[1]);
        if (Number.isFinite(n) && n > 0) return Math.round(n);
      }
    }
    const meta = html.match(/property="product:price:amount"[^>]*content="([\d.]+)"/i);
    if (meta) {
      const n = parseFloat(meta[1]);
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
    // buyabans.com (Vue SSR) has no JSON-LD/meta price at all — the real price
    // is server-rendered straight into the DOM as "Rs. 26,999" inside a
    // main-price/selling-price element. Take the first Rs. figure after that
    // marker (a slice, not the first "Rs." anywhere — earlier "Rs. 0"
    // placeholders/shipping figures on the same page would otherwise win).
    const mainPriceIdx = html.search(/class="main-price"/i);
    if (mainPriceIdx !== -1) {
      const priceMatch = html.slice(mainPriceIdx, mainPriceIdx + 600).match(/Rs\.?\s*([\d,]+)/i);
      const n = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : NaN;
      if (Number.isFinite(n) && n > 0) return Math.round(n);
    }
  } catch {
    // Best-effort only — leaves priceLKR null if the page has no recognizable price.
  }
  return null;
}

// --- Shared factories -------------------------------------------------------

// WooCommerce's public Store REST API — identical shape across every WP/WC
// site that has it enabled. Used verbatim by 6 of the 25 sites below.
function wooStoreApiSearch(domain) {
  return async (term) => {
    const data = await fetchJson(
      `https://${domain}/wp-json/wc/store/v1/products?search=${encodeURIComponent(term)}&per_page=10`,
    );
    if (!Array.isArray(data)) return [];
    return data.map((p) => ({ name: p.name, url: p.permalink, priceLKR: wooPrice(p) }));
  };
}

// WooCommerce + FiboSearch (dgwt_wcas) AJAX autocomplete — served as
// text/html content-type but the body is JSON.
function fiboSearch(domain) {
  return async (term) => {
    const data = await fetchJson(
      `https://${domain}/?wc-ajax=dgwt_wcas_ajax_search&s=${encodeURIComponent(term)}`,
    );
    const suggestions = data?.suggestions || [];
    return suggestions
      .filter((s) => s.type === 'product')
      .map((s) => ({ name: s.value, url: s.url, priceLKR: parsePriceLKR(s.price) }));
  };
}

// Shopify's standard predictive-search endpoint.
function shopifySuggest(domain) {
  return async (term) => {
    const data = await fetchJson(
      `https://${domain}/search/suggest.json?q=${encodeURIComponent(term)}&resources[type]=product&resources[limit]=10`,
    );
    const products = data?.resources?.results?.products || [];
    return products.map((p) => ({
      name: p.title,
      url: abs(`https://${domain}`, p.url),
      priceLKR: parsePriceLKR(p.price),
    }));
  };
}

// GET-then-POST CSRF+cookie flow shared by several custom Laravel storefronts.
// `parse` turns the POST response body into normalized candidates.
function csrfFormSearch({ homepage, buildRequest, parse }) {
  return async (term) => {
    const home = await fetchText(homepage);
    const setCookie = cookieHeader(home.headers);
    const csrfMatch = home.text.match(/name="csrf-token"\s+content="([^"]+)"/i);
    const csrf = csrfMatch ? csrfMatch[1] : null;
    const { url, opts } = buildRequest({ term, csrf, cookie: setCookie });
    const res = await fetchText(url, opts);
    if (!res.ok) return [];
    return parse(res.text);
  };
}

// --- Site adapters -----------------------------------------------------------

export const SITE_ADAPTERS = [
  // --- Original 5 curated sites ---
  {
    domain: 'buyabans.com',
    name: 'Abans',
    search: async (term) => {
      const data = await fetchJson(`https://buyabans.com/search?query=${encodeURIComponent(term)}`);
      const results = data?.results || [];
      return results.map((r) => ({
        name: r.product_name,
        url: `https://buyabans.com/${r.product_url}`,
        priceLKR: null, // hydrated from the product page by the orchestrator
      }));
    },
  },
  {
    domain: 'mysoftlogic.lk',
    name: 'Softlogic',
    search: async (term) => {
      const { ok, text: html } = await fetchText(
        `https://mysoftlogic.lk/search?search-text=${encodeURIComponent(term)}`,
      );
      if (!ok) return [];
      const $ = cheerio.load(html);
      const out = [];
      $('#itemContainer a[href*="/p/"]').each((_, el) => {
        const $el = $(el);
        const url = abs('https://mysoftlogic.lk', $el.attr('href'));
        const name = $el.find('.product_name a').attr('title') || $el.attr('title') || $el.text().trim();
        const priceAttr = $el.find('.product_price[data-price]').attr('data-price');
        if (!name || !url) return;
        out.push({ name: name.trim(), url, priceLKR: priceAttr ? Number(priceAttr) : null });
      });
      return out;
    },
  },
  { domain: 'thinex.lk', name: 'Thinex', search: fiboSearch('thinex.lk') },
  { domain: 'simplytek.lk', name: 'SimplyTek', search: shopifySuggest('www.simplytek.lk') },
  { domain: 'brownsdeals.com', name: 'Browns Deals', search: shopifySuggest('brownsdeals.com') },

  // --- 15 discovered general-electronics sites ---
  {
    domain: 'singersl.com',
    name: 'Singer',
    search: csrfFormSearch({
      homepage: 'https://www.singersl.com/',
      buildRequest: ({ term, csrf, cookie }) => ({
        url: 'https://www.singersl.com/category-search',
        opts: {
          method: 'POST',
          headers: {
            'x-csrf-token': csrf || '',
            'x-requested-with': 'XMLHttpRequest',
            'content-type': 'application/x-www-form-urlencoded',
            cookie,
          },
          body: `_token=${encodeURIComponent(csrf || '')}&search=${encodeURIComponent(term)}&category_id=`,
        },
      }),
      parse: (text) => {
        let items;
        try {
          items = JSON.parse(text);
        } catch {
          return [];
        }
        if (!Array.isArray(items)) return [];
        return items
          .filter((i) => i.type === 1)
          .map((i) => ({
            name: String(i.label || '').replace(/^.*? in /i, ''),
            url: i.link,
            priceLKR: parsePriceLKR(i.price),
          }));
      },
    }),
  },
  { domain: 'dinapalagroup.lk', name: 'Dinapala Group', search: wooStoreApiSearch('dinapalagroup.lk') },
  {
    domain: 'singhagiri.lk',
    name: 'Singhagiri',
    search: async (term) => {
      const { ok, text: html } = await fetchText(`https://singhagiri.lk/filter?search=${encodeURIComponent(term)}`);
      if (!ok) return [];
      const $ = cheerio.load(html);
      const out = [];
      $('.product').each((_, el) => {
        const $el = $(el);
        const $a = $el.find('h6.product_title a').first();
        const name = $a.text().trim();
        const url = $a.attr('href');
        const priceLKR = parsePriceLKR($el.find('.product_price .price').first().text());
        if (!name || !url) return;
        out.push({ name, url: abs('https://singhagiri.lk', url), priceLKR });
      });
      return out;
    },
  },
  {
    domain: 'bigdeals.lk',
    name: 'Big Deals',
    search: async (term) => {
      const data = await fetchJson(`https://bigdeals.lk/search/result/data?q=${encodeURIComponent(term)}`);
      if (!Array.isArray(data)) return [];
      return data.map((p) => ({
        name: p.product_name,
        url: `https://bigdeals.lk/${p.category_slug}/${p.product_slug}`,
        priceLKR: parsePriceLKR(p.deal_price ?? p.original_price),
      }));
    },
  },
  { domain: 'wasi.lk', name: 'Wasi', search: wooStoreApiSearch('wasi.lk') },
  {
    domain: 'sense.lk',
    name: 'Sense',
    search: async (term) => {
      const data = await fetchJson(`https://www.sense.lk/search-live?searchKey=${encodeURIComponent(term)}`);
      const html = data?.html;
      if (!html) return [];
      const $ = cheerio.load(html);
      const out = [];
      $('a[href^="https://www.sense.lk/product/"]').each((_, el) => {
        const $el = $(el);
        const name = ($el.find('h6').attr('title') || $el.find('h6').text() || '').trim();
        const priceLKR = parsePriceLKR($el.find('.product-price').text());
        const url = $el.attr('href');
        if (!name || !url) return;
        out.push({ name, url, priceLKR });
      });
      return out;
    },
  },
  {
    // Apple-only reseller (iPhones/iPads/MacBooks) — narrow scope compared to
    // the other general-electronics sites, but a real, distinct competitor.
    domain: 'luxuryx.lk',
    name: 'LuxuryX',
    search: async (term) => {
      const home = await fetchText('https://luxuryx.lk/');
      if (!home.ok) return [];
      const csrfMatch = home.text.match(/name="csrf-token"\s+content="([^"]+)"/i);
      const csrf = csrfMatch ? csrfMatch[1] : null;
      const setCookie = cookieHeader(home.headers);
      const xsrfMatch = setCookie.match(/XSRF-TOKEN=([^;]+)/);
      const xsrfCookie = xsrfMatch ? decodeURIComponent(xsrfMatch[1]) : null;
      const snapMatch = home.text.match(/wire:snapshot="([^"]*guest\.search\.search-widget[^"]*)"/);
      if (!csrf || !xsrfCookie || !snapMatch) return [];
      const snapshot = snapMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');

      const { ok, text } = await fetchText('https://luxuryx.lk/livewire/update', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-livewire': 'true',
          'x-csrf-token': csrf,
          'x-xsrf-token': xsrfCookie,
          cookie: setCookie,
        },
        body: JSON.stringify({
          _token: csrf,
          components: [{ snapshot, updates: { query: term }, calls: [] }],
        }),
      });
      if (!ok) return [];
      let data;
      try {
        data = JSON.parse(text);
        const innerSnapshot = JSON.parse(data.components[0].snapshot);
        const pairs = innerSnapshot?.data?.results?.[0] || [];
        return pairs
          .map((pair) => pair?.[0])
          .filter((p) => p && p.product_title)
          .map((p) => ({
            name: p.product_title,
            url: `https://luxuryx.lk/products/${p.product_slug}`,
            priceLKR: parsePriceLKR(p.min_price),
          }));
      } catch {
        return [];
      }
    },
  },
  {
    domain: 'abansit.lk',
    name: 'Abans IT',
    search: async (term) => {
      const { ok, text: html } = await fetchText(`https://abansit.lk/welcome/search?keyword=${encodeURIComponent(term)}`);
      if (!ok) return [];
      const $ = cheerio.load(html);
      const out = [];
      $('li a[href^="https://abansit.lk/product-details/"]').each((_, el) => {
        const $el = $(el);
        const name = ($el.find('h2').text() || $el.find('img').attr('alt') || '').trim();
        const url = $el.attr('href');
        if (!name || !url) return;
        out.push({ name, url, priceLKR: null });
      });
      return out;
    },
  },
  {
    domain: 'nanotek.lk',
    name: 'Nanotek',
    search: csrfFormSearch({
      homepage: 'https://www.nanotek.lk/',
      buildRequest: ({ term, csrf, cookie }) => ({
        url: 'https://www.nanotek.lk/search',
        opts: {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
          body: `_token=${encodeURIComponent(csrf || '')}&searchKey=${encodeURIComponent(term)}`,
        },
      }),
      parse: (text) => {
        let html;
        try {
          html = JSON.parse(text);
        } catch {
          html = text;
        }
        if (typeof html !== 'string') return [];
        const $ = cheerio.load(html);
        const out = [];
        $('li.ty-item a[href^="https://www.nanotek.lk/product/"]').each((_, el) => {
          const $el = $(el);
          const name = $el.find('.ty-item-title').text().trim();
          const priceLKR = parsePriceLKR($el.find('.ty-item-price').text());
          const url = $el.attr('href');
          if (!name || !url) return;
          out.push({ name, url, priceLKR });
        });
        return out;
      },
    }),
  },
  {
    domain: 'chamacomputers.lk',
    name: 'Chama Computers',
    search: async (term) => {
      const escaped = term.replace(/"/g, '\\"');
      const query = `*[_type=="product" && name match "*${escaped}*"][0...10]{name, "category": category->name}`;
      const data = await fetchJson(
        `https://yqd1zell.api.sanity.io/v2021-06-07/data/query/production?query=${encodeURIComponent(query)}`,
      );
      const results = data?.result || [];
      return results
        .filter((p) => p.name && p.category)
        .map((p) => ({
          name: p.name,
          url: `https://www.chamacomputers.lk/products/${encodeURIComponent(p.category.toLowerCase())}/${encodeURIComponent(p.name.toLowerCase())}`,
          priceLKR: null, // hydrated from the product page (JSON-LD) by the orchestrator
        }));
    },
  },
  { domain: 'greenware.lk', name: 'Greenware', search: wooStoreApiSearch('www.greenware.lk') },

  // --- 10 category-specialist sites ---
  {
    domain: 'barclays.lk',
    name: 'Barclays',
    search: async (term) => {
      const { ok, text: html } = await fetchText('https://barclays.lk/searchresult.asp', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `SearchWord=${encodeURIComponent(term)}&FrmSearchWords=${encodeURIComponent(term)}&hidSearchStringType=2`,
      });
      if (!ok) return [];
      const $ = cheerio.load(html);
      const out = [];
      $('.product-item').each((_, el) => {
        const $el = $(el);
        const $a = $el.find('.item-title a').first();
        const name = $a.text().trim();
        const url = $a.attr('href');
        const priceLKR = parsePriceLKR($el.find('.item-price .price').first().text());
        if (!name || !url) return;
        out.push({ name, url: abs('https://barclays.lk', url), priceLKR });
      });
      return out;
    },
  },
  {
    domain: 'mskcomputers.lk',
    name: 'MSK Computers',
    search: async (term) => {
      const data = await fetchJson(`https://mskcomputers.lk/api/search/suggestions?q=${encodeURIComponent(term)}`);
      const products = data?.products || [];
      return products.map((p) => ({
        name: p.name,
        url: `https://mskcomputers.lk/${p.category?.slug || 'product'}/${p.slug}`,
        priceLKR: parsePriceLKR(p.final_price ?? p.price),
      }));
    },
  },
  {
    domain: 'mcentre.lk',
    name: 'M Centre',
    search: async (term) => {
      const { ok, text: html } = await fetchText(`https://mcentre.lk/store/search?find=${encodeURIComponent(term)}`);
      if (!ok) return [];
      const $ = cheerio.load(html);
      const out = [];
      $('.b-prod-card').each((_, el) => {
        const $el = $(el);
        const $a = $el.find('.b-prod-card__title a').first();
        const name = $a.text().trim();
        const url = $a.attr('href');
        const priceLKR = parsePriceLKR($el.find('.b-prod-card__price-val').first().text());
        if (!name || !url) return;
        out.push({ name, url: abs('https://mcentre.lk', url), priceLKR });
      });
      return out;
    },
  },
  {
    domain: 'cameralk.com',
    name: 'CameraLK',
    search: async (term) => {
      const { ok, text: html } = await fetchText(`https://www.cameralk.com/search?q=${encodeURIComponent(term)}`);
      if (!ok) return [];
      const $ = cheerio.load(html);
      const out = [];
      const seen = new Set();
      $('a[href*="/product/"]').each((_, el) => {
        const $el = $(el);
        const url = abs('https://www.cameralk.com', $el.attr('href'));
        const name = $el.text().trim();
        if (!name || !url || seen.has(url)) return;
        seen.add(url);
        out.push({ name, url, priceLKR: null });
      });
      return out;
    },
  },
  { domain: 'rangashopping.lk', name: 'Ranga Shopping', search: wooStoreApiSearch('rangashopping.lk') },
  { domain: 'celltronics.lk', name: 'Celltronics', search: wooStoreApiSearch('celltronics.lk') },
  {
    domain: 'redlinetech.lk',
    name: 'Redline Tech',
    search: csrfFormSearch({
      homepage: 'https://www.redlinetech.lk/',
      buildRequest: ({ term, csrf, cookie }) => ({
        url: 'https://www.redlinetech.lk/search',
        opts: {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'x-requested-with': 'XMLHttpRequest',
            cookie,
          },
          body: `_token=${encodeURIComponent(csrf || '')}&searchKey=${encodeURIComponent(term)}`,
        },
      }),
      parse: (html) => {
        const $ = cheerio.load(html);
        const out = [];
        $('li').each((_, el) => {
          const $el = $(el);
          const $a = $el.find('a[href*="/product/"]').first();
          const name = $el.find('h2').text().trim();
          const url = $a.attr('href');
          const priceLKR = parsePriceLKR($el.find('.ty-price').text());
          if (!name || !url) return;
          out.push({ name, url, priceLKR });
        });
        return out;
      },
    }),
  },
];

// Sites that need a real browser (Cloudflare-protected) — handled separately
// by playwright-adapters.js since they need a shared, reusable browser
// instance rather than a fresh launch per call.
export const PLAYWRIGHT_SITE_DOMAINS = ['otc.lk', 'directdealz.lk'];
