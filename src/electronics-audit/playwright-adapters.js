// Search adapters for the 2 sites (of 25) that sit behind a Cloudflare
// challenge plain fetch() can't clear — otc.lk and directdealz.lk. Both
// cleared the challenge in investigation once a real browser context visited
// the homepage first, so this keeps ONE shared browser+context alive across
// the whole audit run rather than launching a fresh one per product.

import * as cheerio from 'cheerio';

let browserPromise = null;
let contextPromise = null;
const warmedDomains = new Set();

async function getContext() {
  if (!browserPromise) {
    const { chromium } = await import('playwright');
    browserPromise = chromium.launch();
  }
  if (!contextPromise) {
    contextPromise = browserPromise.then((b) => b.newContext());
  }
  return contextPromise;
}

async function warmUp(context, origin) {
  if (warmedDomains.has(origin)) return;
  const page = await context.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    warmedDomains.add(origin);
  } finally {
    await page.close();
  }
}

async function fetchViaBrowser(url, origin) {
  const context = await getContext();
  await warmUp(context, origin);
  const page = await context.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
    return { ok: res?.ok() ?? false, text };
  } finally {
    await page.close();
  }
}

function wooPrice(p) {
  const price = p?.prices?.price;
  if (price == null) return null;
  const minorUnit = p?.prices?.currency_minor_unit ?? 2;
  const n = Number(price) / 10 ** minorUnit;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function parsePriceLKR(text) {
  if (text == null) return null;
  const m = String(text).match(/[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export const PLAYWRIGHT_SITE_ADAPTERS = [
  {
    domain: 'otc.lk',
    name: 'OTC',
    search: async (term) => {
      const { ok, text } = await fetchViaBrowser(
        `https://otc.lk/wp-json/wc/store/v1/products?search=${encodeURIComponent(term)}&per_page=10`,
        'https://otc.lk/',
      );
      if (!ok) return [];
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return [];
      }
      if (!Array.isArray(data)) return [];
      return data.map((p) => ({ name: p.name, url: p.permalink, priceLKR: wooPrice(p) }));
    },
  },
  {
    domain: 'directdealz.lk',
    name: 'Direct Dealz',
    search: async (term) => {
      const { ok, text: html } = await fetchViaBrowser(
        `https://directdealz.lk/?s=${encodeURIComponent(term)}&post_type=product`,
        'https://directdealz.lk/',
      );
      if (!ok) return [];
      const $ = cheerio.load(html);
      const out = [];
      $('.wd-product').each((_, el) => {
        const $el = $(el);
        const name = $el.find('.wd-entities-title').first().text().trim();
        const url = $el.find('a[href*="/product/"]').first().attr('href');
        const priceText = $el.find('.price').first().text();
        const matches = priceText.match(/LKR\s*[\d,]+(?:\.\d+)?/g) || [];
        const priceLKR = matches.length ? parsePriceLKR(matches[matches.length - 1]) : null;
        if (!name || !url) return;
        out.push({ name, url, priceLKR });
      });
      return out;
    },
  },
];

export async function closeSharedBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
    browserPromise = null;
    contextPromise = null;
    warmedDomains.clear();
  }
}
