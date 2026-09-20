// Catalogue fetchers for the two sites being reconciled, parameterised by
// partner so the same code works for any Kapruka partner (see the shared
// `partners` table in Supabase, src/compare/partners.js).
//
//   Kapruka (our listing):  server-rendered partner page. Pages are loaded via
//     the same endpoint the "View more" button hits:
//     /srilanka_online_shopping.jsp?partner=<slug>&p=N  — we read each product
//     card from the HTML.
//
//   Partner's own site: platform is auto-detected and the full catalogue pulled
//     from a public endpoint:
//       · WooCommerce -> /wp-json/wc/store/v1/products (Stop N Shop is this)
//       · Shopify     -> /products.json
//     A partner on any other platform needs a bespoke adapter added here.

import * as cheerio from 'cheerio';
import { decodeEntities } from './normalize.js';
import { convertToLkr } from './fx.js';
import { index } from './matcher.js';

// Some product names are mojibake: real UTF-8 punctuation got mis-decoded
// (sometimes twice), leaving clusters like [A-hat|a-hat]+euro+quote. The lead
// char is noise; the trailing char identifies the intended punctuation.
function fixMojibake(s) {
  return s
    .replace(/[Ââ]€“/g, "–") // en dash
    .replace(/[Ââ]€”/g, "—") // em dash
    .replace(/[Ââ]€™/g, "’") // right single quote
    .replace(/[Ââ]€˜/g, "‘") // left single quote
    .replace(/[Ââ]€œ/g, "“") // left double quote
    .replace(/[Ââ]€/g, "”") // right double quote
    .replace(/Â /g, " "); // non-breaking space
}

// Some WAFs (Wordfence, generic bot-fight heuristics) 403 requests that lack a
// standard browser Accept header or that self-identify as a bot, even with no
// JS challenge involved -- a realistic UA + Accept header alone gets through.
const UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-LK,en;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

// Some partner sites (e.g. dimoretail.lk) sit behind Cloudflare's bot-protection
// JS challenge, which 403s plain fetch() requests before our code ever sees the
// platform. A real (even headless) browser can pass that challenge; a bare
// fetch() cannot. Set DISABLE_BROWSER=1 on hosts with no Playwright browser
// installed (e.g. Render free tier) to skip this fallback entirely.
const BROWSER_DISABLED = /^(1|true)$/i.test(process.env.DISABLE_BROWSER || '');

// Kapruka geolocates prices by the real connecting IP (headers don't override it),
// so a server hosted abroad sees USD instead of LKR. Set SCRAPE_PROXY to a Sri
// Lankan-exit HTTP(S) proxy to force LKR pricing. Left blank, requests go direct
// (correct when the host itself is in Sri Lanka).
const SCRAPE_PROXY = process.env.SCRAPE_PROXY || '';
let proxyDispatcher; // lazily-created undici ProxyAgent, reused across requests

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A single page of pagination hitting a 429 used to kill the whole catalog
// fetch outright (multi-page partners like thinex/Joey Clothing/Shirohana
// trip Kapruka's rate limit partway through and never finish). Retry a 429 a
// few times with backoff — honouring Retry-After when Kapruka sends one —
// before giving up. Every other non-OK status still fails immediately, same
// as before.
const RATE_LIMIT_RETRIES = 7;

// Retried 429s used to be completely silent, so "we got rate-limited a lot but
// recovered" looked identical to "nothing happened" — which matters when a
// sweep runs several partners at once and needs to report whether its
// concurrency was too high. Counted here (and logged once per hit) so callers
// like src/tools/force-refresh-all-partners.js can report it.
let rateLimitRetries = 0;
export function rateLimitRetryCount() {
  return rateLimitRetries;
}

// Transient connection failures are retried too, for the same reason 429s are.
// Under a multi-partner sweep Kapruka doesn't only answer 429 — once its
// limiter is hot it also drops connections outright (ECONNRESET / "socket hang
// up" / UND_ERR_SOCKET), and a single dropped socket on page 3 of a 9-page
// catalogue used to abort that entire partner with a bare "fetch failed".
// Observed 2026-09-20: 15 of the first 20 partners in a concurrency-4 sweep
// died this way, while every one of them refreshed fine when re-run alone.
// Five attempts over ~60s of backoff, matching the 429 ladder's patience:
// when Kapruka's limiter is hot (e.g. a second sweep started soon after the
// first) it stops answering altogether for tens of seconds at a time, so a
// short ladder just fails the partner a little more slowly.
const NETWORK_RETRIES = 5;

// Codes worth trying again. ENOTFOUND is deliberately absent — a domain that
// doesn't resolve won't start resolving three seconds later, and retrying it
// only slows the sweep down and muddies the "dns-failure" diagnosis.
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ENETRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

let networkRetries = 0;
export function networkRetryCount() {
  return networkRetries;
}

// undici buries the real reason one or two levels down in `cause`, which is why
// these failures surface as an unhelpful bare "fetch failed". Dig the code out
// so both the retry decision and the error message can name it.
function networkErrorCode(err) {
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (typeof e.code === 'string') return e.code;
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'ETIMEDOUT';
    if (/socket hang up/i.test(e.message || '')) return 'ECONNRESET';
  }
  return null;
}

async function fetchText(url) {
  let networkAttempts = 0;
  for (let attempt = 0; ; attempt++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 30000);
    const opts = { headers: UA, redirect: 'follow', signal: c.signal };
    if (SCRAPE_PROXY) {
      if (!proxyDispatcher) {
        const { ProxyAgent } = await import('undici');
        proxyDispatcher = new ProxyAgent(SCRAPE_PROXY);
      }
      opts.dispatcher = proxyDispatcher;
    }
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const retryAfter = Number(r.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 30000); // 1s, 2s, 4s, 8s, 16s, 30s, 30s
        rateLimitRetries += 1;
        console.warn(`  · HTTP 429 rate-limited, retrying in ${waitMs}ms: ${url}`);
        await sleep(waitMs);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.text();
    } catch (err) {
      // An HTTP-status failure thrown just above is a real answer from the
      // server — leave it alone. Only connection-level faults are retried.
      const code = err instanceof Error && !/^HTTP \d{3} /.test(err.message)
        ? networkErrorCode(err)
        : null;
      if (code && RETRYABLE_NETWORK_CODES.has(code) && networkAttempts < NETWORK_RETRIES) {
        const waitMs = Math.min(2000 * 2 ** networkAttempts, 30000); // 2s, 4s, 8s, 16s, 30s
        networkAttempts += 1;
        networkRetries += 1;
        console.warn(`  · connection failed (${code}), retrying in ${waitMs}ms: ${url}`);
        await sleep(waitMs);
        continue;
      }
      // Bare "fetch failed" says nothing a failure report can act on; name the
      // underlying code so the sweep can classify it (see classifyError in
      // src/tools/force-refresh-all-partners.js).
      if (code) throw new Error(`${code} — ${err.message} for ${url}`, { cause: err });
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

// Fetch JSON, returning null on any non-JSON / error response (used for
// platform probing where a 404 just means "not this platform").
async function fetchJsonSafe(url) {
  try {
    const text = await fetchText(url);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Is this origin actively blocking us (as opposed to just not running
// WooCommerce/Shopify)? Checked once, only after both direct platform probes
// come back empty, so normal (unblocked) partners never pay for this extra call.
async function isCloudflareBlocked(origin) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    const opts = { headers: UA, redirect: 'follow', signal: c.signal };
    if (SCRAPE_PROXY) {
      if (!proxyDispatcher) {
        const { ProxyAgent } = await import('undici');
        proxyDispatcher = new ProxyAgent(SCRAPE_PROXY);
      }
      opts.dispatcher = proxyDispatcher;
    }
    const r = await fetch(origin, opts);
    clearTimeout(t);
    if (r.status !== 403) return false;
    return r.headers.get('cf-mitigated') != null || (r.headers.get('server') || '').toLowerCase() === 'cloudflare';
  } catch {
    return false;
  }
}

// Fetch JSON through a real browser instead of fetch() — the only way past a
// Cloudflare JS challenge. Slow and not guaranteed to pass, so this is only
// ever tried as a last resort, never as the first attempt.
//
// Three things this has to get right, all learned the hard way against
// tomahawkbike.com and theminisecret.com (both went to "0 products" while this
// fallback reported success at passing nothing):
//
//   1. HEADED beats headless. Cloudflare's managed challenge fingerprints
//      headless Chromium (and even channel:'chrome' in headless mode) and never
//      clears it — the interstitial just sits there forever. The same challenge
//      clears in ~12s in a headed window. So: try headless first (cheap, works
//      for the softer WAFs), then retry headed unless SCRAPE_HEADED=0 says this
//      host has no display (a Linux VPS/container, where launching headed just
//      throws and we end up back at null, same as before).
//   2. Wait for the JSON, don't sleep a fixed 6s. The old blind wait both
//      wasted 6s on sites that answer instantly and gave up on ones that take
//      12-15s. Poll until the body parses as JSON.
//   3. Reuse the browser AND the per-origin context. This used to launch (and
//      throw away) a whole browser per request, so a 5-page catalogue re-ran
//      the challenge 5 times from scratch. Keeping the context keeps the
//      cf_clearance cookie, so only the first page pays for the challenge.
const HEADED_DISABLED = /^(0|false)$/i.test(process.env.SCRAPE_HEADED || '');
const BROWSER_IDLE_MS = 120000;

const browsers = new Map(); // headed:boolean -> Promise<Browser>
const browserContexts = new Map(); // `${headed}|${origin}` -> Promise<BrowserContext>
let browserIdleTimer = null;

async function launchBrowser(headed) {
  const { chromium } = await import('playwright');
  const launchOpts = { headless: !headed };
  if (headed) launchOpts.args = ['--disable-blink-features=AutomationControlled'];
  if (SCRAPE_PROXY) launchOpts.proxy = { server: SCRAPE_PROXY };
  return chromium.launch(launchOpts);
}

function getBrowser(headed) {
  if (!browsers.has(headed)) browsers.set(headed, launchBrowser(headed));
  return browsers.get(headed);
}

async function getBrowserContext(origin, headed) {
  const key = `${headed}|${origin}`;
  if (!browserContexts.has(key)) {
    browserContexts.set(
      key,
      (async () => {
        const browser = await getBrowser(headed);
        // Deliberately NOT forcing UA['User-Agent'] here. That string is a
        // pinned Chrome/124 that no longer matches the Chromium actually doing
        // the navigating, and Cloudflare compares the two: with the override
        // the challenge never cleared, without it the same page cleared in ~9s
        // (measured on tomahawkbike.com). The browser's own UA is consistent
        // with its fingerprint, which is the whole point of using a browser.
        return browser.newContext({
          locale: 'en-US',
          extraHTTPHeaders: { 'Accept-Language': UA['Accept-Language'] },
        });
      })(),
    );
  }
  return browserContexts.get(key);
}

// Close every browser this module opened. Exported so a CLI sweep can exit
// promptly instead of waiting on the idle timer; the server never has to call
// it (the idle timer below closes an unused browser on its own).
export async function closeScrapeBrowsers() {
  clearTimeout(browserIdleTimer);
  browserIdleTimer = null;
  const pending = [...browsers.values()];
  browsers.clear();
  browserContexts.clear();
  await Promise.all(
    pending.map(async (p) => {
      try {
        await (await p).close();
      } catch {
        /* already gone */
      }
    }),
  );
}

function scheduleBrowserIdleClose() {
  clearTimeout(browserIdleTimer);
  browserIdleTimer = setTimeout(() => {
    closeScrapeBrowsers().catch(() => {});
  }, BROWSER_IDLE_MS);
  browserIdleTimer.unref?.(); // never hold the process open just for this
}

const CHALLENGE_TEXT = /just a moment|security verification|attention required|checking your browser|enable javascript and cookies/i;

// One navigation, polled until the response body parses as JSON (or we run out
// of patience). Returns { json } on success, or { challenged } saying whether
// what we were left staring at was a bot-protection interstitial (as opposed to
// an ordinary 404/HTML page), which tells the caller whether escalating to a
// headed browser is worth the time.
async function readJsonInBrowser(context, url, waitMs) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + waitMs;
    let challenged = false;
    for (;;) {
      let text = null;
      try {
        text = await page.evaluate(() => document.body.innerText);
      } catch {
        // "Execution context was destroyed" — the challenge just navigated the
        // page to the real response, which is exactly what we're waiting for.
        challenged = true;
      }
      if (text) {
        try {
          return { json: JSON.parse(text), challenged };
        } catch {
          challenged = challenged || CHALLENGE_TEXT.test(text);
          // Nothing to wait for if this is just a plain HTML page (a 404, a
          // "not WooCommerce" shop front): only a live challenge changes on
          // its own, so stop burning the timeout on anything else.
          if (!challenged) return { json: null, challenged };
        }
      }
      if (Date.now() >= deadline) return { json: null, challenged };
      await page.waitForTimeout(2000);
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// Origins where headless has already been proved useless. Remembered because
// catalogues are paginated: without this, every single page of a Cloudflare-
// challenged shop would waste its headless attempt again before escalating.
const headlessHopeless = new Set();

// Only one headed challenge at a time, process-wide. Two challenged partners
// running in the same sweep (concurrency 2) had one pass and one hang forever;
// the one that hung passed on its own a minute later. Headed windows compete
// for focus, and an unfocused challenge widget can just sit there — so the
// sweep's concurrency has to stop at this door.
let headedQueue = Promise.resolve();
function withHeadedLock(fn) {
  const run = headedQueue.then(fn, fn);
  headedQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function fetchJsonViaBrowser(url) {
  if (BROWSER_DISABLED) return null;
  let origin;
  try {
    origin = toOrigin(url);
  } catch {
    return null;
  }
  const modes = [];
  if (!headlessHopeless.has(origin)) modes.push(false);
  if (!HEADED_DISABLED) modes.push(true);
  try {
    for (const headed of modes) {
      let result = null;
      try {
        const read = async () => {
          const context = await getBrowserContext(origin, headed);
          return readJsonInBrowser(context, url, headed ? 40000 : 15000);
        };
        result = headed ? await withHeadedLock(read) : await read();
      } catch {
        // A crashed/closed browser shouldn't poison every later call — drop the
        // cached handles for this mode so the next attempt relaunches cleanly.
        browserContexts.delete(`${headed}|${origin}`);
        browsers.delete(headed);
      }
      if (result?.json != null) return result.json;
      if (!headed && result?.challenged) headlessHopeless.add(origin);
      // A headless miss that wasn't a challenge means the endpoint genuinely
      // isn't there — a headed retry would return the same 404 more slowly.
      if (!headed && result && !result.challenged) return null;
    }
    return null;
  } finally {
    scheduleBrowserIdleClose();
  }
}

// Normalise a site URL to its origin (https://host), no trailing slash.
function toOrigin(site) {
  const u = new URL(site.startsWith('http') ? site : `https://${site}`);
  return u.origin;
}

// Fetch just the status code for a URL (still a GET -- plenty of these hosts
// 405 a HEAD). Returns null on a network-level failure (DNS, refused, TLS,
// timeout), which is a different answer from "the server said 404".
async function statusOf(url, timeoutMs = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const opts = { method: 'GET', headers: UA, redirect: 'follow', signal: c.signal };
    if (SCRAPE_PROXY) {
      if (!proxyDispatcher) {
        const { ProxyAgent } = await import('undici');
        proxyDispatcher = new ProxyAgent(SCRAPE_PROXY);
      }
      opts.dispatcher = proxyDispatcher;
    }
    const r = await fetch(url, opts);
    return r.status;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// How many of a partner's product pages we sample when deciding whether the
// storefront is actually usable. Spread across the catalogue so one deleted
// product (or one whole dead category) can't condemn a healthy shop -- every
// single sample has to be gone before we call the store dead.
const HEALTH_SAMPLE_SIZE = 4;

// Evenly-spaced sample of product URLs from a catalogue, deduped.
function sampleProductUrls(products, n = HEALTH_SAMPLE_SIZE) {
  const urls = [...new Set((products || []).map((p) => (typeof p === 'string' ? p : p?.url)).filter(Boolean))];
  if (urls.length <= n) return urls;
  const step = urls.length / n;
  return Array.from({ length: n }, (_, i) => urls[Math.floor(i * step)]);
}

const HEALTH_LABELS = {
  ok: 'online',
  unreachable: 'site unreachable (no response at all)',
  server_error: 'site returning a server error',
  origin_missing: 'domain answers but the shop front page is gone',
  storefront_dead: 'home page loads but no product page opens — nothing can actually be bought',
  empty_catalogue: 'site is up but lists no products at all',
};
export function siteHealthLabel(reason) {
  return HEALTH_LABELS[reason] || reason || 'unknown';
}

// Is the partner's own website actually a working shop? -- a different (and
// much more useful) question than the one this used to ask, which was only
// "did anything answer the connection."
//
// The old rule -- GET the origin, call it alive on any status below 500 -- let
// genuinely dead stores keep driving repricing decisions. thinex.lk is the
// worked example: its home page returns a perfectly healthy 200, but every
// pretty permalink underneath it (/product/..., /shop/, /cart/) 404s, so no
// customer can open a product, let alone buy one. Its catalogue still reads
// fine over the WooCommerce Store API's ?rest_route= form, so the comparison
// run "succeeded" and the store showed up as our single biggest overpricing
// gap -- a competitor that cannot take an order.
//
// So the verdict now needs three things to be true: the domain answers, the
// origin isn't a 4xx/5xx error page, and at least one real product page from
// the freshly-scraped catalogue actually opens. Deliberately conservative
// about false positives, because hiding a live competitor costs us real
// margin intelligence:
//   · a network failure on a *sample* (not the origin) is inconclusive, so it
//     counts as alive -- only an explicit 404/410 means "page is gone";
//   · 401/403 on the origin is a WAF blocking us, not a dead shop -- alive;
//   · every single sample has to be 404/410 before we call it dead.
//
// Returns { active, reason, detail }; see HEALTH_LABELS for the reasons.
export async function checkSiteHealth(site, { products = [], log = () => {} } = {}) {
  let origin;
  try {
    origin = toOrigin(site);
  } catch {
    return { active: false, reason: 'unreachable', detail: `Unparseable site URL: ${site}` };
  }

  // One retry before condemning a site on a timeout: a single slow response
  // under the sweep's concurrency is not evidence a shop has closed, and this
  // verdict sticks until the next refresh.
  let originStatus = await statusOf(origin);
  if (originStatus == null) originStatus = await statusOf(origin, 25000);

  const samples = sampleProductUrls(products);
  const sampleStatuses = samples.length ? await Promise.all(samples.map((u) => statusOf(u))) : [];
  // A product page that actually serves is the strongest possible evidence the
  // shop is trading -- it outranks anything the home page did, including a
  // timeout on a slow apex domain (iloveceylon.com does exactly this).
  const opens = sampleStatuses.filter((s) => s != null && s < 400).length;
  if (opens > 0) {
    return { active: true, reason: 'ok', detail: `${opens}/${sampleStatuses.length} sampled product page(s) open` };
  }

  if (originStatus == null) {
    return { active: false, reason: 'unreachable', detail: `No response from ${origin} (two attempts)` };
  }
  if (originStatus >= 500) {
    return { active: false, reason: 'server_error', detail: `${origin} returned HTTP ${originStatus}` };
  }
  // 401/403 is us being blocked, not the shop being shut. Anything else in the
  // 4xx range on the *home page* means there's no shop front left to visit.
  if (originStatus >= 400 && originStatus !== 401 && originStatus !== 403) {
    return { active: false, reason: 'origin_missing', detail: `${origin} returned HTTP ${originStatus}` };
  }

  // Home page is fine. Every sampled product page being an explicit 404/410 is
  // the thinex.lk case: a shop you can look at but not buy from. Samples that
  // merely timed out or got WAF-blocked prove nothing, so they don't count.
  const gone = sampleStatuses.filter((s) => s === 404 || s === 410).length;
  if (sampleStatuses.length && gone === sampleStatuses.length) {
    log(`  ✗ ${origin}: home page is up but all ${gone} sampled product page(s) 404 — storefront is dead`);
    return {
      active: false,
      reason: 'storefront_dead',
      detail: `${origin} home page HTTP ${originStatus}, but all ${gone} sampled product page(s) returned 404/410`,
    };
  }

  // Either there was no catalogue to sample, or the samples were inconclusive.
  // The home page answered, so we can't say more than that from here.
  return { active: true, reason: 'ok', detail: `${origin} returned HTTP ${originStatus}` };
}

// Back-compat boolean wrapper: "is the partner site alive?" without the reason.
export async function checkSiteActive(site, opts) {
  return (await checkSiteHealth(site, opts)).active;
}

// ---- Kapruka -------------------------------------------------------------

// Kapruka exposes the same product cards through two listing endpoints. We turn
// a pasted Kapruka link into a "source descriptor" so either can drive the tool:
//   · partner storefront   /partner/<slug>
//       -> srilanka_online_shopping.jsp?partner=<slug>
//   · brand/category list  /online/<category>[/price/<brand>]
//       -> srilanka_online_catalogue.jsp?buy=<category>[&subcat=<brand>]
export function parseKaprukaSource(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/\/partner\/([^/?#]+)/i);
  if (m) return { type: 'partner', slug: m[1], label: m[1], link: `https://www.kapruka.com/partner/${m[1]}` };
  m = s.match(/\/online\/([^/?#]+)(?:\/price\/([^/?#]+))?/i);
  if (m) {
    const link = `https://www.kapruka.com/online/${m[1]}${m[2] ? `/price/${m[2]}` : ''}`;
    return { type: 'catalogue', buy: m[1], subcat: m[2] || null, label: m[2] ? `${m[1]} / ${m[2]}` : m[1], link };
  }
  // A bare token (no slashes/spaces) is treated as a partner slug.
  if (!s.includes('/') && !s.includes(' ')) {
    return { type: 'partner', slug: s, label: s, link: `https://www.kapruka.com/partner/${s}` };
  }
  return null;
}

// Read a single Kapruka product page (kapruka.com/buyonline/...) into a source
// descriptor we can drive the price-checker with: the product name, description
// and Kapruka's own price become the query + reference. Kapruka renders a clean
// Product JSON-LD (name/description/brand/category/offers); we fall back to
// og:/meta tags if that's ever missing.
export async function fetchKaprukaProduct(url) {
  if (!/kapruka\.com/i.test(String(url || ''))) {
    throw new Error('Paste a Kapruka product link (kapruka.com/buyonline/...).');
  }
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  let product = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    let json;
    try {
      json = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = Array.isArray(json) ? json : json['@graph'] || [json];
    for (const n of nodes) {
      const ty = n && n['@type'];
      if (ty === 'Product' || (Array.isArray(ty) && ty.includes('Product'))) {
        product = n;
        break;
      }
    }
  });

  const offers = product
    ? Array.isArray(product.offers)
      ? product.offers
      : product.offers
        ? [product.offers]
        : []
    : [];
  const offer = offers.find((o) => o && (o.price ?? o.lowPrice) != null) || offers[0] || null;

  const clean = (s) => fixMojibake(decodeEntities(String(s || ''))).replace(/\s+/g, ' ').trim();

  const name =
    clean(product?.name) ||
    clean($('h1').first().text()) ||
    clean($('meta[property="og:title"]').attr('content')).split('|')[0].trim();

  const description =
    clean(product?.description) || clean($('meta[property="og:description"]').attr('content'));

  const rawPrice =
    offer?.price ??
    offer?.lowPrice ??
    $('meta[property="product:price:amount"]').attr('content') ??
    null;
  // USD amounts have decimals (e.g. "33.29") that a digits-only parseInt would
  // truncate to 33, so keep the decimal here and round after currency conversion below.
  const priceNum = rawPrice != null ? parseFloat(String(rawPrice).replace(/[^0-9.]/g, '')) : NaN;
  let price = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : null;

  let currency =
    offer?.priceCurrency ||
    $('meta[property="product:price:currency"]').attr('content') ||
    'LKR';

  // Kapruka geo-converts prices for non-Sri-Lankan server IPs (see the note on
  // SCRAPE_ON_ADD in server.js — this VPS is confirmed to get bad geo-pricing).
  // Which currency it picks isn't fixed to USD — it can also come back as AED,
  // GBP, etc. depending on how the IP resolves. Single-product resolves have
  // no LKR-only fallback like the catalogue scraper's kaprukaLkrPriceMap
  // below, so convert whatever currency it is instead of displaying the
  // foreign number as if it were rupees.
  if (price != null && currency && !/^LKR$/i.test(currency)) {
    price = await convertToLkr(price, currency);
    currency = 'LKR';
  } else if (price != null) {
    price = Math.round(price);
  }

  const image =
    (Array.isArray(product?.image) ? product.image[0] : product?.image) ||
    $('meta[property="og:image"]').attr('content') ||
    null;

  const inStock = offer?.availability ? !/OutOfStock/i.test(offer.availability) : null;

  return {
    name,
    description,
    price,
    currency,
    image,
    inStock,
    category: clean(product?.category) || null,
    brand: clean(typeof product?.brand === 'object' ? product?.brand?.name : product?.brand) || null,
    url,
  };
}

// The catalogue endpoint base for a source (callers append &p=N&onlyCatalogueSection=true).
export function kaprukaBaseUrl(src) {
  if (src.type === 'partner') {
    return `https://www.kapruka.com/srilanka_online_shopping.jsp?partner=${encodeURIComponent(src.slug)}`;
  }
  let u = `https://www.kapruka.com/srilanka_online_catalogue.jsp?buy=${encodeURIComponent(src.buy)}`;
  if (src.subcat) u += `&subcat=${encodeURIComponent(src.subcat)}`;
  return u;
}

// The visible ".catalogueV2converted" price is GEO-CONVERTED: international
// visitors (e.g. a server hosted abroad) get it in USD, not LKR — so a Rs.219,000
// TV renders as "$811" and naively parsing the number stores 811 as if it were
// rupees. The per-product JSON-LD offer, however, carries the canonical LKR price
// regardless of geo. So we build an LKR price map from the JSON-LD (keyed by the
// product code in /kid/<code>) and use the visible span only as an LKR-only
// fallback. Regex over each <script> block rather than JSON.parse, because some
// product names contain characters that make the JSON-LD invalid JSON.
// Also builds the per-product stock map alongside price: each catalogue-page
// product card carries its own Product JSON-LD block (same one price is read
// from above), and that block's offers.availability is a genuine, geo-independent
// schema.org InStock/OutOfStock signal — not previously read, so parseKaprukaPage()
// below used to hardcode every Kapruka product as in stock regardless of reality.
function kaprukaLkrPriceMap(html) {
  const priceMap = new Map();
  const stockMap = new Map();
  const blocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    if (!/"@type"\s*:\s*"Product"/i.test(block)) continue;
    const url = (block.match(/"url"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const kid = (url.match(/\/kid\/([^/"?#]+)/i) || [])[1];
    if (!kid) continue;
    const kidKey = kid.toLowerCase();
    const cur = (block.match(/"priceCurrency"\s*:\s*"?(\w+)/i) || [])[1];
    const priceStr = (block.match(/"price"\s*:\s*"?([\d.]+)/i) || [])[1];
    if (priceStr && /^LKR$/i.test(cur || '')) {
      const price = Math.round(parseFloat(priceStr));
      if (Number.isFinite(price) && price > 0) priceMap.set(kidKey, price);
    }
    const availability = (block.match(/"availability"\s*:\s*"([^"]+)"/) || [])[1];
    if (availability) stockMap.set(kidKey, !/OutOfStock/i.test(availability));
  }
  return { priceMap, stockMap };
}

function parseKaprukaPage(html) {
  const $ = cheerio.load(html);
  const { priceMap: lkrByKid, stockMap: stockByKid } = kaprukaLkrPriceMap(html);
  const out = [];
  $('a[href*="/buyonline/"]').each((_, el) => {
    const $a = $(el);
    const heading = $a.find('.catalogueV2heading').first();
    if (heading.length === 0) return; // not a product card (e.g. a plain link)
    const name = fixMojibake(decodeEntities(heading.text()).replace(/\s+/g, ' ').trim());
    if (!name) return;
    const href = $a.attr('href') || '';
    const kid = (href.match(/\/kid\/([^/"?#]+)/i) || [])[1];
    const kidKey = kid ? kid.toLowerCase() : null;

    // 1) Canonical LKR price from JSON-LD (geo-independent).
    let price = kidKey ? lkrByKid.get(kidKey) ?? null : null;

    // 2) Fallback: the visible price, but ONLY when it's rendered in LKR. If the
    //    page geo-converted to USD/another currency, leave price null rather than
    //    storing a foreign number as rupees.
    if (price == null) {
      const priceEl = $a.find('.catalogueV2converted, .CatalogueV2price').first().clone();
      priceEl.find('[style*="line-through"]').remove();
      const txt = priceEl.text();
      if (/rs\.?|lkr|₨/i.test(txt)) {
        const m = txt.match(/(\d[\d,]*)/);
        price = m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
      }
    }
    // Default to in-stock when a card has no JSON-LD availability of its own
    // (rare) rather than assuming the worse case for missing data.
    const inStock = kidKey && stockByKid.has(kidKey) ? stockByKid.get(kidKey) : true;
    out.push({ name, price, url: href, inStock });
  });
  return out;
}

// How much of the query's own tokens show up in a candidate title. One-
// directional and deliberately not run through matcher.js's score() or
// audit-scoring.js's scoreCandidate() -- both are tuned for cross-site
// IDENTITY matching (near-duplicate SKU across two catalogues) and reject
// on any of several narrower grounds that don't apply here: matcher.js's
// score() requires the CANDIDATE's tokens be near-fully contained in the
// query too (fails on any real listing, which always carries extra words
// like "MagSafe"/"Clear"/"Sri Lanka"), and scoreCandidate()'s
// accessoryMismatch() treats "case" and "cover" as different accessory
// categories (rejects "iPhone 12 cover" against a real "...Clear Case"
// listing, confirmed live). This just ranks Kapruka's OWN already-
// relevance-sorted search results by query-token coverage -- Kapruka's own
// search engine did the hard filtering; this only needs to pick the best
// of what it already returned.
// How far apart two same-unit spec values (weight/volume/etc., e.g. "50g" vs
// "51g") can be and still count as the same product -- covers a site
// rounding a pack size in its own title. Deliberately scoped to _specs
// (extractSpecs()'s digit+unit matches, e.g. "51g") rather than bare numeric
// tokens: an earlier version compared any two numeric tokens within 10% and
// that let "iPhone 12" match "iPhone 13" (an 8% gap) since ordinary model
// numbers sit close together too -- a unit letter is what actually marks a
// number as a rounding-prone quantity instead of an identity digit.
const SPEC_VALUE_TOLERANCE = 0.1;
function specsHaveCloseValue(value, unit, specs) {
  const values = specs[unit];
  if (!values) return false;
  for (const v of values) {
    if (Math.abs(v - value) <= Math.max(v, value) * SPEC_VALUE_TOLERANCE) return true;
  }
  return false;
}

function queryCoverage(qTokens, cTokens, qSpecs, cSpecs) {
  if (!qTokens.size) return 0;
  let matched = 0;
  for (const t of qTokens) {
    if (cTokens.has(t)) {
      matched++;
      continue;
    }
    // No exact match -- if this token is a spec value (came from a
    // digit+unit like "51g", tracked in _specs under "g") a close-enough
    // candidate value for the same unit still counts, so "Mars Chocolate Bar
    // 51g" isn't rejected against a Kapruka listing titled "50g" for what's
    // the same product. A bare number with no unit (a model digit like the
    // "12" in "iPhone 12") isn't in _specs at all, so it gets no leniency --
    // it must match exactly.
    const value = Number(t);
    if (Number.isFinite(value)) {
      for (const unit of Object.keys(qSpecs)) {
        if (qSpecs[unit].has(value) && specsHaveCloseValue(value, unit, cSpecs)) {
          matched++;
          break;
        }
      }
    }
  }
  return matched / qTokens.size;
}

// Live search of Kapruka's OWN site (kapruka.com/lk/find_online/<query>) for
// a product by name -- same server-rendered catalogue-card markup as a
// partner's storefront page, so parseKaprukaPage() above reads it directly,
// no separate parser needed.
//
// Built for the Price Checker's price-insight step: that needs Kapruka's
// OWN current price for whatever was typed, but price_audit_items (the
// pre-scraped/audited table) only has a price for products someone has
// already run a category audit against -- a plain, never-audited query
// (e.g. "iPhone 12 cover") had no Kapruka price to compare against at all,
// so no recommendation could ever be shown for it. This covers every
// search, not just ones that happen to already be in that table.
// Full containment, not "most" tokens -- a partial-coverage bar let "iPhone
// 17 MagSafe Cover" satisfy a "iPhone 12 cover" query at 2/3 (iphone+cover)
// purely off two generic words, without the model number "12" itself ever
// matching. For a short query every word carries weight, especially the
// one that's actually a model number -- require all of them.
const KAPRUKA_MATCH_MIN_COVERAGE = 1;

export async function findKaprukaProduct(name) {
  const url = `https://www.kapruka.com/lk/find_online/${encodeURIComponent(name)}`;
  let html;
  try {
    html = await fetchText(url);
  } catch {
    return null;
  }
  const candidates = parseKaprukaPage(html).filter((p) => p.price != null);
  if (!candidates.length) return null;

  const [qIndexed] = index([{ name, url: 'query' }], false);
  const indexed = index(candidates, false);
  // Kapruka's own search returns anything mentioning the query words at all,
  // from the plain product to unrelated gift bouquets/combos whose longer
  // description happens to also mention them (confirmed live: "Mars
  // Chocolate" fully covers both a genuine "Mars 50g Chocolate Bar" AND a
  // "Stylish Beauty Bouquet With Mars Chocolates" gift combo, and site order
  // put the LKR 12,710 bouquet first). Taking the first full-coverage result
  // trusted that ordering blindly; instead, among every candidate clearing
  // the coverage floor, prefer whichever has the fewest tokens beyond the
  // query itself -- the title closest to just being the product name, not a
  // bouquet/gift-box description that happens to also contain it. Kapruka's
  // own order only breaks remaining ties.
  let best = null;
  let bestExtraTokens = Infinity;
  for (const c of indexed) {
    if (queryCoverage(qIndexed._tokens, c._tokens, qIndexed._specs, c._specs) < KAPRUKA_MATCH_MIN_COVERAGE) continue;
    const extraTokens = [...c._tokens].filter((t) => !qIndexed._tokens.has(t)).length;
    if (extraTokens < bestExtraTokens) {
      best = c;
      bestExtraTokens = extraTokens;
    }
  }
  if (!best) return null;
  return { name: best.name, url: best.url.startsWith('http') ? best.url : `https://www.kapruka.com${best.url}`, price: best.price };
}

// `source` is a descriptor from parseKaprukaSource(), or a raw link/slug string.
export async function fetchKaprukaCatalog(source, { log = () => {} } = {}) {
  const src = typeof source === 'string' ? parseKaprukaSource(source) : source;
  if (!src) throw new Error('Unrecognised Kapruka link/source');
  const base = kaprukaBaseUrl(src);
  const byUrl = new Map();
  // Safety ceiling only — the loop's real stopping conditions are an empty
  // page or a page that adds nothing new. 50 was too low for large
  // categories (Electronics has 3000+ products, ~115 pages at 30/page) and
  // was silently truncating them instead of ever being hit as a genuine
  // safety net.
  for (let p = 1; p <= 300; p++) {
    if (p > 1) await sleep(600); // throttle page requests to avoid tripping Kapruka's rate limit
    const html = await fetchText(`${base}&p=${p}&onlyCatalogueSection=true`);
    const items = parseKaprukaPage(html);
    if (items.length === 0) break; // past the last page
    let added = 0;
    for (const it of items) {
      if (!byUrl.has(it.url)) {
        byUrl.set(it.url, it);
        added++;
      }
    }
    log(`  Kapruka page ${p}: ${items.length} cards (${added} new), total ${byUrl.size}`);
    // If a page adds nothing new, pagination has wrapped — stop.
    if (added === 0) break;
  }
  return [...byUrl.values()];
}

// Quick validation probe: how many products are on page 1 of a Kapruka source
// (partner storefront or brand/category listing). One request — used to verify a
// link before saving a new partner.
export async function probeKaprukaSource(input) {
  const src = parseKaprukaSource(input);
  if (!src) return 0;
  const url = `${kaprukaBaseUrl(src)}&p=1&onlyCatalogueSection=true`;
  try {
    const html = await fetchText(url);
    return parseKaprukaPage(html).length;
  } catch {
    return 0;
  }
}

// Detect a partner site's platform with a single tiny request each. Returns
// { platform: 'woocommerce' | 'shopify' | null, viaBrowser: boolean, blocked: boolean }.
// `viaBrowser` tells the caller to persist that flag on the partner, so every
// later comparison run for this partner goes straight to the browser fetch
// instead of wasting time on a direct request that's known to be blocked.
// `blocked` (only meaningful when platform is null) distinguishes "the site
// sits behind Cloudflare/bot-protection and we couldn't get through even via
// a real browser" from "we got through fine, it's just not WooCommerce or
// Shopify" — callers use this to route unsupported sites into two different
// worklists (custom scraper needed vs. block-evasion needed).
export async function detectPartnerPlatform(site) {
  const origin = toOrigin(site);
  const woo = await fetchJsonSafe(`${origin}/wp-json/wc/store/v1/products?per_page=1`);
  if (Array.isArray(woo) && woo.length) return { platform: 'woocommerce', viaBrowser: false, blocked: false };
  const shop = await fetchJsonSafe(`${origin}/products.json?limit=1`);
  if (shop && Array.isArray(shop.products) && shop.products.length) return { platform: 'shopify', viaBrowser: false, blocked: false };

  // Medusa storefronts expose no public catalogue JSON, so this one is a
  // server-rendered listing page rather than an API probe — cheap enough to
  // try before falling back to the (much slower) browser path.
  if (await looksLikeMedusa(site)) return { platform: 'medusa', viaBrowser: false, blocked: false };

  const blocked = await isCloudflareBlocked(origin);
  if (blocked) {
    const wooB = await fetchJsonViaBrowser(`${origin}/wp-json/wc/store/v1/products?per_page=1`);
    if (Array.isArray(wooB) && wooB.length) return { platform: 'woocommerce', viaBrowser: true, blocked: false };
    const shopB = await fetchJsonViaBrowser(`${origin}/products.json?limit=1`);
    if (shopB && Array.isArray(shopB.products) && shopB.products.length) return { platform: 'shopify', viaBrowser: true, blocked: false };
  }
  return { platform: null, viaBrowser: false, blocked };
}

// ---- Partner site (auto-detected platform) -------------------------------

function minorUnitDivide(value, minorUnit) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return null;
  return minorUnit ? n / 10 ** minorUnit : n;
}

// Pull the first plausible number out of a price string, ignoring whatever
// currency symbol precedes it (Rs., LKR, the Sinhala රු, etc.) -- used by the
// WooCommerce HTML fallback below, which reads prices straight off rendered
// markup rather than a currency-tagged API field.
function parsePriceLKR(text) {
  if (text == null) return null;
  const m = String(text).match(/[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// The HTML-scraped adapters below (unlike the WooCommerce REST / Shopify
// paths above, which read the site's own currency-tagged field) have no
// currency field to lean on at all -- just whatever text the theme renders.
// A site that's actually priced in USD ("$45.99") was silently treated as
// Rs. 45.99 by parsePriceLKR, which ignores the symbol entirely -- massively
// underpricing that partner everywhere it's compared. Flag it here instead:
// a "$"/"USD" with no accompanying Rs./LKR marker on the same string is USD,
// everything else stays LKR exactly as before.
function parsePriceMaybeForeign(text) {
  const price = parsePriceLKR(text);
  if (price == null) return null;
  const s = String(text || '');
  const isUsd = /\$|USD/i.test(s) && !/Rs\.?|LKR|රු/i.test(s);
  return { price, currency: isUsd ? 'USD' : 'LKR' };
}

// cheerio's .each() callback can't be async, so parsePriceMaybeForeign just
// flags a foreign price during that (synchronous) pass -- this converts the
// flagged ones afterwards, in one batch. convertToLkr() caches its FX rate
// per currency for 30 minutes, so this costs at most one network call per
// currency per catalogue fetch, not one per product.
async function convertForeignItems(items) {
  for (const item of items) {
    if (item._currency && item._currency !== 'LKR' && item.price != null) {
      item.price = await convertToLkr(item.price, item._currency);
    }
    delete item._currency;
  }
  return items;
}

// WooCommerce Store API: /wp-json/wc/store/v1/products?per_page=100&page=N.
// Prices are integer strings scaled by currency_minor_unit.
//
// Some sites (e.g. thinex.lk) 404 on the pretty /wp-json/... permalink (their
// server rewrite rules don't cover it) but still serve the same data via the
// query-param form. Probe the pretty URL first; if page 1 comes back non-array,
// retry via ?rest_route= and stick with it for the rest of pagination. Without
// this fallback the pretty URL's 404 silently looks like "empty catalogue"
// (fetchJsonSafe returns null on error) rather than a real failure — nothing
// throws, so a force-refresh happily overwrites good stored data with zero.
// baseuscolombo.lk shows two prices per product: a "cash" price (the one the
// WooCommerce Store API reports as price/regular_price) and a higher
// "non-cash"/card price shown only via client-side JS (div.mainpri), not
// present in the API or static HTML at all. Verified across several products
// the site's own "10% off" cash-payment badges account for the gap exactly:
// non-cash = cash / 0.9. Deriving it here avoids rendering all ~800+ product
// pages in a browser just to read one number.
const CASH_DISCOUNT_SITES = ['baseuscolombo.lk'];
const CASH_DISCOUNT_RATE = 0.9;

function isCashDiscountSite(origin) {
  return CASH_DISCOUNT_SITES.some((d) => origin.includes(d));
}

async function fetchWooCatalog(origin, log, fetchJson = fetchJsonSafe) {
  const out = [];
  let useRestRoute = false;
  const deriveNonCash = isCashDiscountSite(origin);
  for (let page = 1; page <= 100; page++) {
    const prettyUrl = `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;
    const restRouteUrl = `${origin}/?rest_route=/wc/store/v1/products&per_page=100&page=${page}`;
    let arr = await fetchJson(useRestRoute ? restRouteUrl : prettyUrl);
    if (!Array.isArray(arr) && page === 1 && !useRestRoute) {
      arr = await fetchJson(restRouteUrl);
      if (Array.isArray(arr)) useRestRoute = true;
    }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const p of arr) {
      const pr = p.prices || {};
      const price = minorUnitDivide(pr.price, pr.currency_minor_unit);
      let regularPrice = minorUnitDivide(pr.regular_price, pr.currency_minor_unit);
      if (deriveNonCash && price != null) {
        regularPrice = Math.round(price / CASH_DISCOUNT_RATE);
      }
      out.push({
        id: `woo-${p.id}`,
        name: decodeEntities(p.name || '').trim(),
        sku: p.sku || '',
        // Brand + most-specific category come straight from the Store API response
        // (no extra request). Both are optional taxonomies, so guard for absence.
        brand: decodeEntities(p.brands?.[0]?.name || '').trim(),
        category: decodeEntities(p.categories?.[0]?.name || '').trim(),
        price,
        regularPrice,
        url: p.permalink,
        inStock: p.is_in_stock !== false,
      });
    }
    log(`  partner (woo) page ${page}: +${arr.length}, total ${out.length}`);
    if (arr.length < 100) break;
  }
  return out;
}

// Shopify's public /products.json carries no currency field at all — prices
// are just bare numbers in whatever currency the store's checkout is set to.
// Most Sri Lankan stores run LKR, but some (e.g. ekko.style) run USD, and a
// bare number was previously stored as if it were rupees — turning a $66
// shirt into "Rs. 66", which then reads as wildly "overpriced" on Kapruka's
// side. /cart.json is a stable, unauthenticated Shopify endpoint that always
// reports the store's real currency, even for an empty cart.
async function shopifyStoreCurrency(origin, fetchJson) {
  const cart = await fetchJson(`${origin}/cart.json`);
  const cur = String(cart?.currency || '').toUpperCase();
  return cur || 'LKR';
}

// Shopify: /products.json?limit=250&page=N. Prices are major-unit strings; we
// take the cheapest available variant and its SKU.
async function fetchShopifyCatalog(origin, log, fetchJson = fetchJsonSafe) {
  const out = [];
  const currency = await shopifyStoreCurrency(origin, fetchJson).catch(() => 'LKR');
  if (currency !== 'LKR') log(`  partner (shopify) store currency: ${currency} — converting prices to LKR`);
  for (let page = 1; page <= 100; page++) {
    const data = await fetchJson(`${origin}/products.json?limit=250&page=${page}`);
    const products = data && Array.isArray(data.products) ? data.products : null;
    if (!products || products.length === 0) break;
    for (const p of products) {
      const variants = (p.variants || [])
        .map((v) => ({
          price: parseFloat(v.price),
          regularPrice: parseFloat(v.compare_at_price),
          sku: v.sku,
          available: v.available !== false,
        }))
        .filter((v) => Number.isFinite(v.price) && v.price > 0);
      if (variants.length === 0) continue;
      // Prefer the first variant marked available (Shopify's default/first-
      // shown option) over the globally cheapest one. Some listings mix wildly
      // different price tiers under one product -- e.g. this book's variants
      // are "Perfect" Rs.9,400 / "Paperback" Rs.2,200 / "Imperfect" Rs.1,000 --
      // and picking the minimum grabbed a damaged-copy price instead of the
      // standard listing, making a fair-priced product look 10x overpriced.
      const pick = variants.find((v) => v.available) || variants[0];
      const price = currency === 'LKR' ? Math.round(pick.price) : await convertToLkr(pick.price, currency);
      const regularPrice = Number.isFinite(pick.regularPrice) && pick.regularPrice > 0
        ? (currency === 'LKR' ? Math.round(pick.regularPrice) : await convertToLkr(pick.regularPrice, currency))
        : null;
      out.push({
        id: `shopify-${p.id}`,
        name: decodeEntities(p.title || '').trim(),
        sku: pick.sku || '',
        // product_type ~ category; vendor ~ brand (note: vendor is often the store
        // name on Shopify, so treat it as a best-effort brand signal).
        brand: (p.vendor || '').trim(),
        category: (p.product_type || '').trim(),
        price,
        regularPrice,
        url: `${origin}/products/${p.handle}`,
        inStock: variants.some((v) => v.available),
      });
    }
    log(`  partner (shopify) page ${page}: +${products.length}, total ${out.length}`);
    if (products.length < 250) break;
  }
  return out;
}

// Fallback for WooCommerce sites whose Store API (/wp-json/wc/store/v1/...)
// is disabled, blocked, or absent -- scrape the public shop listing pages
// directly instead. WooCommerce's *price* markup (.price / .woocommerce-
// Price-amount) is rendered by the plugin's own PHP templates, not the theme,
// so it survives across wildly different themes even when the surrounding
// grid markup (ul.products vs theme-specific divs) doesn't. Strategy: find
// every /product/<slug>/ permalink on the page, walk up from each link to the
// nearest ancestor that also contains a .price element (and not so many
// product links that we've walked past the card into the whole grid), and
// read the title/price from there. `shopUrl` must be the exact listing page
// (e.g. "https://site.com/shop/"), not just the origin -- these sites don't
// follow one consistent path.
async function parseWooHtmlPage(html, origin) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const out = [];
  $('a[href*="/product/"]').each((_, el) => {
    const $a = $(el);
    let href = $a.attr('href');
    if (!href) return;
    href = href.split('?')[0].split('#')[0];
    if (!href.endsWith('/')) href += '/';
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;

    let $card = $a;
    let found = null;
    for (let i = 0; i < 8; i++) {
      $card = $card.parent();
      if ($card.length === 0) break;
      const linkCount = $card.find('a[href*="/product/"]').length;
      if ($card.find('.price').first().length && linkCount <= 3) { found = $card; break; }
      if (linkCount > 3) break; // walked past the card into the whole grid
    }
    if (!found) return;

    const priceEl = found.find('.price').first();
    const saleAmt = priceEl.find('ins .woocommerce-Price-amount, ins .amount').first();
    const amt = saleAmt.length ? saleAmt : priceEl.find('.woocommerce-Price-amount, .amount').first();
    const parsed = parsePriceMaybeForeign((amt.length ? amt : priceEl).text());
    if (!parsed) return;

    const title = fixMojibake(decodeEntities(
      found.find('h1,h2,h3,h4,.woocommerce-loop-product__title,.wd-entities-title,.product-title,.product_title')
        .first().text() || $a.attr('aria-label') || $a.attr('title') || $a.text(),
    )).replace(/\s+/g, ' ').trim();
    if (!title) return;

    seen.add(href);
    out.push({ id: `woohtml-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

// Some sites front WooCommerce with a WAF (Wordfence, Cloudflare bot-fight) that
// intermittently 403s a fresh page render while a cached hit sails straight
// through -- same origin, same request, different result a few seconds apart.
// A 403/429/503 is worth a couple of retries; a 404 past the last page is not.
const TRANSIENT_STATUS = /HTTP (403|429|503)\b/;

async function fetchWooHtmlCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const base = shopUrl.replace(/\/?$/, '/');
  const byUrl = new Map();
  for (let page = 1; page <= 60; page++) {
    const url = page === 1 ? base : `${base}page/${page}/`;
    let html;
    for (let attempt = 0; ; attempt++) {
      try {
        html = await fetchTextFn(url);
        break;
      } catch (e) {
        if (TRANSIENT_STATUS.test(e.message) && attempt < 3) {
          await sleep(4000 * (attempt + 1));
          continue;
        }
        html = null;
        break; // page N/A (404 past the last page, or a block that didn't clear) -- stop
      }
    }
    if (html == null) break;
    const products = await parseWooHtmlPage(html, origin);
    if (products.length === 0) break;
    let added = 0;
    for (const p of products) {
      if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; }
    }
    log(`  partner (woo-html) page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
    if (added === 0) break; // pagination wrapped or plateaued
    if (page > 1) await sleep(500); // be polite -- this is a full page render, not a lightweight API call
  }
  return [...byUrl.values()];
}

// ---- Bespoke per-site adapters --------------------------------------------
// A handful of partners run hand-coded storefronts sharing no common CMS, so
// each needs its own small scraper. All return the standard [{ id, name,
// price, url }] shape fetchPartnerCatalog expects.

// -- Odoo (website_sale) -- shared by disnies.lk and harvest.lk (and any
// future Odoo-based partner). Card markup differs slightly by theme/version
// between the two confirmed installs, so this reads from whichever stable
// class/attribute is present rather than one exact selector.
async function parseOdooListingPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('form.oe_product_cart').each((_, el) => {
    const $card = $(el);
    const $link = $card.find('a.oe_product_image_link[href]').first();
    let href = $link.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    const parsed = parsePriceMaybeForeign($card.find('.oe_currency_value').first().text());
    if (!parsed) return;
    const nameLink = $card.find('a[itemprop="name"]').first();
    const title = fixMojibake(decodeEntities(
      (nameLink.length ? nameLink.text() : '') || $link.attr('title') || $link.find('img').attr('alt') || '',
    )).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `odoo-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchOdooCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const base = shopUrl.replace(/\/?$/, '');
  const byUrl = new Map();
  for (let page = 1; page <= 60; page++) {
    const url = page === 1 ? base : `${base}/page/${page}`;
    let html;
    for (let attempt = 0; ; attempt++) {
      try {
        html = await fetchTextFn(url);
        break;
      } catch (e) {
        if (TRANSIENT_STATUS.test(e.message) && attempt < 3) {
          await sleep(4000 * (attempt + 1));
          continue;
        }
        html = null;
        break;
      }
    }
    if (html == null) break;
    const products = await parseOdooListingPage(html, origin);
    if (products.length === 0) break;
    let added = 0;
    for (const p of products) {
      if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; }
    }
    log(`  partner (odoo) page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
    if (added === 0) break;
    if (page > 1) await sleep(500);
  }
  return [...byUrl.values()];
}

// -- ichouse.lk (Pubudu Electronics) -- the whole catalogue lives in one
// public Firestore document (no auth needed); a single request beats
// crawling category pages. Firestore's REST API wraps every value in a
// type tag ({ stringValue, integerValue, arrayValue, mapValue, ... }).
function unwrapFirestoreValue(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(unwrapFirestoreValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = unwrapFirestoreValue(val);
    return out;
  }
  return null;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

async function fetchIchouseCatalog(fetchJson = fetchJsonSafe) {
  const url = 'https://firestore.googleapis.com/v1/projects/pubudueshop-cde28/databases/(default)/documents/shop/inventory';
  const doc = await fetchJson(url);
  const products = doc?.fields?.products?.arrayValue?.values || [];
  const out = [];
  for (const raw of products) {
    const p = unwrapFirestoreValue(raw);
    if (!p || !p.title || !p.price) continue;
    const slug = `${slugify(p.mainCategory)}/${slugify(p.subCategory)}/${slugify(p.title)}`;
    out.push({ id: `ichouse-${p.id}`, name: p.title, price: Math.round(p.price), url: `https://ichouse.lk/${slug}/` });
  }
  return out;
}

// -- kidsmarket.lk -- CodeIgniter storefront; pagination is a path offset
// (12 products/page). Page 1's pagination widget exposes the total page
// count directly, so no guessing is needed.
async function parseKidsmarketPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('a[href*="/product/kidsmarket/"]').each((_, el) => {
    const $a = $(el);
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    let $card = $a;
    let priceEl = null;
    for (let i = 0; i < 6; i++) {
      $card = $card.parent();
      if ($card.length === 0) break;
      const p = $card.find('p.text-xl.font-bold.text-brand-blue').first();
      if (p.length) { priceEl = p; break; }
    }
    if (!priceEl) return;
    const parsed = parsePriceMaybeForeign(priceEl.text());
    if (!parsed) return;
    const title = fixMojibake(decodeEntities(
      $card.find('h4.font-semibold.text-lg.text-brand-dark').first().text() || $a.text(),
    )).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `kidsmarket-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchKidsmarketCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const base = `${origin}/shop/products`;
  let html;
  try { html = await fetchTextFn(base); } catch { return []; }
  const byUrl = new Map();
  for (const p of await parseKidsmarketPage(html, origin)) byUrl.set(p.url, p);
  log(`  partner (kidsmarket) page 1: ${byUrl.size} cards`);
  let lastPage = 1;
  const $page1 = cheerio.load(html);
  $page1('[data-ci-pagination-page]').each((_, el) => {
    const n = Number($page1(el).attr('data-ci-pagination-page'));
    if (Number.isFinite(n) && n > lastPage) lastPage = n;
  });
  const PER_PAGE = 12;
  for (let page = 2; page <= lastPage; page++) {
    const offset = (page - 1) * PER_PAGE;
    let h;
    for (let attempt = 0; ; attempt++) {
      try { h = await fetchTextFn(`${base}/${offset}`); break; }
      catch (e) {
        if (TRANSIENT_STATUS.test(e.message) && attempt < 3) { await sleep(4000 * (attempt + 1)); continue; }
        h = null;
        break;
      }
    }
    if (h == null) break;
    const products = await parseKidsmarketPage(h, origin);
    let added = 0;
    for (const p of products) { if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; } }
    log(`  partner (kidsmarket) page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
    await sleep(500);
  }
  return [...byUrl.values()];
}

// -- liveu.lk -- Laravel storefront whose listing endpoint honours a
// per_page override, so the whole catalogue comes back in one request.
async function parseLiveuPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.vertical-product-card').each((_, el) => {
    const $card = $(el);
    const $a = $card.find('a.card-title').first();
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    const parsed = parsePriceMaybeForeign($card.find('h6.price span.text-danger').first().text());
    if (!parsed) return;
    const title = fixMojibake(decodeEntities($a.text())).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `liveu-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchLiveuCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const html = await fetchTextFn(`${origin}/products?per_page=500`);
  const products = await parseLiveuPage(html, origin);
  log(`  partner (liveu) single page: ${products.length} cards`);
  return products;
}

// -- scgraphic.com (SC Promotion) -- entire catalogue renders on one page.
async function parseScgraphicPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.product-card').each((_, el) => {
    const $card = $(el);
    const $a = $card.find('a.btn-details[href]').first();
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    const $discounted = $card.find('span.discounted-price').first();
    const priceEl = $discounted.length ? $discounted : $card.find('span.regular-price').first();
    const parsed = parsePriceMaybeForeign(priceEl.text());
    if (!parsed) return;
    const title = fixMojibake(decodeEntities($card.find('div.product-name').first().text())).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `scgraphic-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchScgraphicCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const html = await fetchTextFn(`${origin}/shop.php`);
  const products = await parseScgraphicPage(html, origin);
  log(`  partner (scgraphic) single page: ${products.length} cards`);
  return products;
}

// -- Agrola Ceylon's Daraz shop -- Daraz's shop product grid is loaded via a
// signed internal API with no static fallback, and its search/pagination
// endpoints trip Alibaba's TMD anti-bot challenge (an active CAPTCHA wall,
// not a header check -- not something to route around). Manually maintained
// from the shop page instead: https://www.daraz.lk/shop/x4cu9fso/
// Update by re-checking that page and editing the list below.
const AGROLA_DARAZ_SHOP_URL = 'https://www.daraz.lk/shop/x4cu9fso/';
const AGROLA_DARAZ_PRODUCTS = [
  { name: 'AGROLA Ceylon Cinnamon Antioxidant Booster Tea | 3-Pack Combo', price: 2025 },
  { name: 'AGROLA Ceylon Cinnamon Detox & Weight Loss Tea - 20 Tea Bags', price: 750 },
  { name: 'AGROLA Ceylon Hibiscus Spearmint Herbal Tea - 20 Tea Bags', price: 750 },
  { name: 'Agrola Ceylon Moringa Super Wellness Herbal Tea - 20 Tea Bags', price: 750 },
  { name: 'AGROLA Ceylon Cinnamon Antioxidant Booster Tea - 20 Tea Bags', price: 750 },
];

async function fetchAgrolaDarazCatalog(log) {
  log(`  partner (agrola-daraz) manually maintained list: ${AGROLA_DARAZ_PRODUCTS.length} products`);
  return AGROLA_DARAZ_PRODUCTS.map((p, i) => ({
    id: `agrola-daraz-${i}`,
    name: p.name,
    price: p.price,
    url: AGROLA_DARAZ_SHOP_URL,
  }));
}

// -- jeewakaherbals.com/jhstore -- AbanteCart storefront; the brand's main
// domain is a marketing page, the real store lives under /jhstore/ across
// three known category paths (8 products/page).
const JHSTORE_CATEGORY_PATHS = [43, 52, 68];

async function parseJhstorePage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.product-card').each((_, el) => {
    const $card = $(el);
    const $a = $card.find('a[href*="rt=product/product"]').first();
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    if (seen.has(href)) return;
    const parsed = parsePriceMaybeForeign($card.find('div.price').first().text());
    if (!parsed) return; // also drops genuine Rs.0.00 "call for price" entries
    const title = fixMojibake(decodeEntities($card.find('div.card-title').first().text())).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({ id: `jhstore-${href}`, name: title, price: parsed.price, url: href, _currency: parsed.currency });
  });
  return convertForeignItems(out);
}

async function fetchJhstoreCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const byUrl = new Map();
  for (const path of JHSTORE_CATEGORY_PATHS) {
    for (let page = 1; page <= 20; page++) {
      const url = `${origin}/jhstore/index.php?rt=product/category&path=${path}&page=${page}&limit=8`;
      let html;
      try { html = await fetchTextFn(url); } catch { break; }
      const products = await parseJhstorePage(html, origin);
      if (products.length === 0) break;
      let added = 0;
      for (const p of products) { if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; } }
      log(`  partner (jhstore) path=${path} page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
      if (added === 0) break;
      await sleep(400);
    }
  }
  return [...byUrl.values()];
}

// -- limitededition.lk -- OpenCart (Journal theme). The Store-API probes both
// miss it (it's neither Woo nor Shopify) and it publishes no XML sitemap or
// product feed, so there's no single endpoint listing the whole catalogue.
// The category pages only cover part of it (several products sit solely in
// month "collection" categories that aren't linked from the main nav), so
// instead this drives OpenCart's own search route, which does span every
// category, and unions the results of a few single-letter queries. Nearly
// every product name contains at least one of these, and each letter
// independently returns ~the full 109-product catalogue -- the union is
// belt-and-braces against a name that happens to miss one.
const LIMITEDEDITION_SEARCH_TERMS = ['a', 'e', 'i', 'o', 'u', 's'];

function parseLimitedEditionPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  $('div.product-thumb').each((_, el) => {
    const $card = $(el);
    const $a = $card.find('h4.name a').first();
    let href = $a.attr('href');
    if (!href) return;
    if (!href.startsWith('http')) href = new URL(href, origin).toString();
    // Listing links carry the paging params through (…?limit=100) -- strip the
    // query so the same product found via two different searches dedupes.
    href = href.split('?')[0];
    if (seen.has(href)) return;
    const $price = $card.find('div.price').first();
    // On a discounted product the theme renders both the struck-through
    // original (.price-old) and the live one (.price-new); undiscounted
    // products just have the bare text. Take .price-new when present so a
    // sale price isn't misread as the regular price, and keep .price-old as
    // regularPrice so the dashboard's discount badge works the same way it
    // does for Woo's regular_price / Shopify's compare_at_price.
    const $new = $price.find('.price-new').first();
    const parsed = parsePriceMaybeForeign($new.length ? $new.text() : $price.clone().children().remove().end().text());
    if (!parsed) return;
    const $old = $price.find('.price-old').first();
    const regular = $old.length ? parsePriceLKR($old.text()) : null;
    const title = fixMojibake(decodeEntities($a.text())).replace(/\s+/g, ' ').trim();
    if (!title) return;
    seen.add(href);
    out.push({
      id: `limitededition-${href}`,
      name: title,
      price: parsed.price,
      regularPrice: regular,
      url: href,
      _currency: parsed.currency,
    });
  });
  return convertForeignItems(out);
}

async function fetchLimitedEditionCatalog(shopUrl, log, fetchTextFn = fetchText) {
  const origin = toOrigin(shopUrl);
  const byUrl = new Map();
  for (const term of LIMITEDEDITION_SEARCH_TERMS) {
    for (let page = 1; page <= 20; page++) {
      const url = `${origin}/index.php?route=product/search&search=${term}&limit=100&page=${page}`;
      let html;
      for (let attempt = 0; ; attempt++) {
        try { html = await fetchTextFn(url); break; }
        catch (e) {
          if (TRANSIENT_STATUS.test(e.message) && attempt < 3) { await sleep(4000 * (attempt + 1)); continue; }
          html = null;
          break;
        }
      }
      if (html == null) break;
      const products = await parseLimitedEditionPage(html, origin);
      if (products.length === 0) break;
      let added = 0;
      for (const p of products) { if (!byUrl.has(p.url)) { byUrl.set(p.url, p); added++; } }
      log(`  partner (limitededition) search=${term} page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
      // "Showing 1 to 100 of 109 (2 Pages)" -- stop once this term is exhausted
      // rather than fetching a page that's guaranteed empty.
      const shown = html.match(/Showing\s+\d+\s+to\s+(\d+)\s+of\s+(\d+)/i);
      if (shown && Number(shown[1]) >= Number(shown[2])) break;
      await sleep(400);
    }
  }
  return [...byUrl.values()];
}

// -- parkerpensrilanka.com -- the storefront isn't hosted platform code at
// all, it's an embedded Ecwid widget (store id 85158655) rendered client-side
// into the page. Ecwid's storefront-api.ecwid.com/.../catalog endpoint
// returns the whole catalogue as one JSON payload, but a bare fetch() to it
// 404s -- the browser resolves it through a region-specific host
// (eu-fra2-storefront-api.ecwid.com here) via some session/discovery step
// that isn't a header or cookie a plain request can replicate. Rather than
// reverse-engineer that, a real headless browser page load is used to
// capture the response directly off the network -- expensive per call, but
// this is exactly one page load for the ENTIRE catalogue (Ecwid returns
// everything in one response, no pagination), unlike a Cloudflare-challenge
// browser fallback that's just one product's worth of relief.
async function fetchEcwidCatalogViaBrowser(shopUrl, log = () => {}) {
  if (BROWSER_DISABLED) return [];
  const origin = toOrigin(shopUrl);
  const { chromium } = await import('playwright');
  const launchOpts = {};
  if (SCRAPE_PROXY) launchOpts.proxy = { server: SCRAPE_PROXY };
  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext({ userAgent: UA['User-Agent'] });
    const page = await context.newPage();
    const catalogPromise = page
      .waitForResponse(
        (res) => /storefront-api\.ecwid\.com\/.*\/catalog(\?|$)/.test(res.url()),
        { timeout: 30000 },
      )
      .catch(() => null);
    await page.goto(`${origin}/shop`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const res = await catalogPromise;
    if (!res) { log('  partner (ecwid) catalog response never arrived'); return []; }
    const json = await res.json().catch(() => null);
    if (!json) return [];

    const out = [];
    const walk = (cat) => {
      for (const p of cat.products || []) {
        const price = p.defaultOptionsOverrides?.pricesOverrides?.basePrice;
        const path = p.urls?.directPageUrl;
        // basePrice can be a genuine 0 for a not-currently-orderable listing
        // (seen on this store's own catalogue) -- not a parsing failure, but
        // not a usable price for comparison either.
        if (!p.name || price == null || price <= 0 || !path) continue;
        out.push({
          id: `ecwid-${p.identifier || path}`,
          name: fixMojibake(decodeEntities(p.name)).replace(/\s+/g, ' ').trim(),
          price: Math.round(price),
          url: path.startsWith('http') ? path : `${origin}${path}`,
        });
      }
      for (const sub of cat.subcategories || []) walk(sub);
    };
    for (const cat of json.expandedCategories || []) walk(cat);
    log(`  partner (ecwid) catalog: ${out.length} products`);
    return out;
  } catch (err) {
    log(`  partner (ecwid) browser fetch failed: ${err.message}`);
    return [];
  } finally {
    await browser.close();
  }
}

// -- foreverskinnaturals.com -- static-exported Next.js shell with no
// server-rendered content at all; the frontend's own backend API returns
// the full catalogue as clean JSON, one entry per size/price variant.
async function fetchForeverskinCatalog(fetchJson = fetchJsonSafe) {
  const doc = await fetchJson('https://api.foreverskinnaturals.com/v1/api/product/all?page=0&size=500');
  const list = doc?.data?.list || [];
  const out = [];
  for (const p of list) {
    for (const s of p.sizes || []) {
      const parsed = parsePriceMaybeForeign(s.price);
      if (!parsed) continue;
      const price = parsed.currency === 'LKR' ? parsed.price : await convertToLkr(parsed.price, parsed.currency);
      out.push({
        id: `foreverskin-${p.id}-${s.sizeId}`,
        name: s.size ? `${p.name} ${s.size}` : p.name,
        price,
        url: `https://foreverskinnaturals.com/product/${p.id}`,
      });
    }
  }
  return out;
}

// -- Medusa storefront (the Next.js "medusa-next" starter) -- agnarsl.com is
// the first partner on it: it used to be WooCommerce, and the day it
// replatformed its /wp-json endpoints started 404ing, so the comparison went
// to zero. There's no public catalogue JSON to read (the Medusa Store API sits
// on a separate backend host behind a publishable key), but the storefront
// server-renders its whole product grid, prices included, so the listing pages
// are the catalogue.
//
// Two storefront quirks this has to handle:
//   · every route is prefixed with a region/country code (/lk/store), which we
//     discover by following the origin's redirect rather than hard-coding "lk";
//   · the grid pages past the first also carry a "recommended" strip of
//     products from elsewhere in the catalogue, so pages overlap — dedupe by
//     URL and stop when a page adds nothing new, same as the woo-html adapter.
const MEDUSA_MAX_PAGES = 40;

// The region-prefixed base path (e.g. "https://agnarsl.com/lk"): taken from the
// configured partner site if it already points inside a region, otherwise from
// wherever the bare origin redirects to.
async function medusaBasePath(site) {
  const origin = toOrigin(site);
  const configured = new URL(site.startsWith('http') ? site : `https://${site}`).pathname;
  const fromSite = configured.match(/^\/([a-z]{2})(?:\/|$)/i);
  if (fromSite) return `${origin}/${fromSite[1].toLowerCase()}`;
  try {
    const res = await fetch(origin, { headers: UA, redirect: 'follow' });
    const landed = new URL(res.url).pathname.match(/^\/([a-z]{2})(?:\/|$)/i);
    if (landed) return `${origin}/${landed[1].toLowerCase()}`;
  } catch {
    /* fall through to the un-prefixed form */
  }
  return origin;
}

function parseMedusaListingPage(html, origin) {
  const $ = cheerio.load(html);
  const out = [];
  $('a[href*="/products/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const url = href.startsWith('http') ? href : `${origin}${href}`;
    // The card's image alt is the clean product name; the anchor's own text is
    // name+price run together ("Agnar Luxe KarmaLKR 8,500.00"), so the name is
    // read from the alt and only the price from the text.
    const name = fixMojibake(decodeEntities($(el).find('img').first().attr('alt') || '')).trim();
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    const priceText = (text.match(/(?:LKR|Rs\.?|USD|\$)\s?[\d.,]+/gi) || []).pop();
    if (!name || !priceText) return;
    const parsed = parsePriceMaybeForeign(priceText);
    if (!parsed || parsed.price == null || parsed.price <= 0) return;
    out.push({ id: `medusa-${url}`, name, price: parsed.price, url, _currency: parsed.currency });
  });
  return out;
}

async function fetchMedusaCatalog(site, log) {
  const origin = toOrigin(site);
  const base = await medusaBasePath(site);
  const byUrl = new Map();
  for (let page = 1; page <= MEDUSA_MAX_PAGES; page++) {
    let html;
    try {
      html = await fetchText(`${base}/store?page=${page}`);
    } catch {
      break; // past the last page, or the storefront stopped answering
    }
    const products = parseMedusaListingPage(html, origin);
    if (!products.length) break;
    let added = 0;
    for (const p of products) {
      if (!byUrl.has(p.url)) {
        byUrl.set(p.url, p);
        added++;
      }
    }
    log(`  partner (medusa) page ${page}: ${products.length} cards (${added} new), total ${byUrl.size}`);
    if (added === 0) break; // pagination wrapped — only repeats from here
    await sleep(400); // full page renders, not a lightweight API call
  }
  return convertForeignItems([...byUrl.values()]);
}

// Cheap "is this a Medusa storefront?" probe: one listing page that yields
// parseable product cards. Used both by detectPartnerPlatform (new partners)
// and by the replatform fallback in fetchPartnerCatalogRaw (existing ones).
async function looksLikeMedusa(site) {
  try {
    const base = await medusaBasePath(site);
    const html = await fetchText(`${base}/store`);
    return parseMedusaListingPage(html, toOrigin(site)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch a partner's full catalogue from their own site, auto-detecting the
 * platform. Returns the standard product shape. Throws if the platform isn't
 * supported (i.e. neither WooCommerce nor Shopify exposed a public catalogue).
 * @param {string} site  partner site URL or host
 * @param {{ log?: (m: string) => void, platform?: string, viaBrowser?: boolean }} [opts]
 *   `viaBrowser` should be true for partners already known to sit behind a
 *   Cloudflare-style block (persisted from detectPartnerPlatform's result).
 */
// Public entry point. Every path below that can return an empty catalogue —
// including the bespoke per-site adapters (woocommerce-html, odoo, ichouse,
// kidsmarket, …) — is funnelled through this one check, because "0 products"
// was being treated as a perfectly good result everywhere downstream. Only the
// throwing path gives compute() the chance to keep the last known good data
// (site offline) or surface a real breakage instead of quietly saving an empty
// comparison over a partner's real one.
export async function fetchPartnerCatalog(site, opts = {}) {
  const result = await fetchPartnerCatalogRaw(site, opts);
  if (!result.products.length) {
    throw new Error(
      `Read 0 products from ${toOrigin(site)} (platform: ${result.platform}). Its catalogue ` +
        `endpoint is empty or blocking us — treating this as a failure rather than saving ` +
        `an empty comparison over the last good one.`,
    );
  }
  return result;
}

async function fetchPartnerCatalogRaw(site, { log = () => {}, platform = 'auto', viaBrowser = false } = {}) {
  const origin = toOrigin(site);
  const fetchJson = viaBrowser ? fetchJsonViaBrowser : fetchJsonSafe;

  if (platform === 'woocommerce-html') {
    const products = await fetchWooHtmlCatalog(site, log);
    return { products, platform: 'woocommerce-html' };
  }
  if (platform === 'odoo') {
    const products = await fetchOdooCatalog(site, log);
    return { products, platform: 'odoo' };
  }
  if (platform === 'ichouse') {
    const products = await fetchIchouseCatalog(fetchJson);
    return { products, platform: 'ichouse' };
  }
  if (platform === 'kidsmarket') {
    const products = await fetchKidsmarketCatalog(site, log);
    return { products, platform: 'kidsmarket' };
  }
  if (platform === 'liveu') {
    const products = await fetchLiveuCatalog(site, log);
    return { products, platform: 'liveu' };
  }
  if (platform === 'scgraphic') {
    const products = await fetchScgraphicCatalog(site, log);
    return { products, platform: 'scgraphic' };
  }
  if (platform === 'agrola-daraz') {
    const products = await fetchAgrolaDarazCatalog(log);
    return { products, platform: 'agrola-daraz' };
  }
  if (platform === 'jhstore') {
    const products = await fetchJhstoreCatalog(site, log);
    return { products, platform: 'jhstore' };
  }
  if (platform === 'limitededition') {
    const products = await fetchLimitedEditionCatalog(site, log);
    return { products, platform: 'limitededition' };
  }
  if (platform === 'ecwid') {
    const products = await fetchEcwidCatalogViaBrowser(site, log);
    return { products, platform: 'ecwid' };
  }
  if (platform === 'foreverskin') {
    const products = await fetchForeverskinCatalog(fetchJson);
    return { products, platform: 'foreverskin' };
  }
  if (platform === 'medusa') {
    const products = await fetchMedusaCatalog(site, log);
    return { products, platform: 'medusa' };
  }
  // An *explicitly configured* woocommerce/shopify partner used to return its
  // empty catalogue straight back rather than trying the browser fallback, so
  // a partner whose Store API started answering 403 (Cloudflare/WAF) never got
  // the one retry that would have worked. Confirmed live: dinapalagroup.lk went
  // from 1,274 products / 60 matches to 0/0 the day its /wp-json endpoint began
  // returning 403 — the headless-browser retry reads it fine.
  if (platform === 'woocommerce' || platform === 'auto') {
    const woo = await fetchWooCatalog(origin, log, fetchJson);
    if (woo.length) return { products: woo, platform: 'woocommerce' };
  }
  if (platform === 'shopify' || platform === 'auto') {
    const shop = await fetchShopifyCatalog(origin, log, fetchJson);
    if (shop.length) return { products: shop, platform: 'shopify' };
  }
  // Direct fetch found nothing — if the site is actively blocking us, retry
  // once through a real browser before giving up.
  if (!viaBrowser && (await isCloudflareBlocked(origin))) {
    log(`  ${origin} looks Cloudflare-blocked — retrying through a real browser…`);
    return fetchPartnerCatalog(site, { log, platform, viaBrowser: true });
  }
  // Still nothing, and this partner is pinned to a platform it clearly isn't
  // serving any more: partners replatform. agnarsl.com moved from WooCommerce
  // to a Medusa/Next.js storefront and simply reported "0 products" on every
  // sweep from that day on, because a pinned platform never re-probed anything
  // else. Re-detect once here so a replatformed store heals itself instead of
  // sitting at zero until somebody reads a refresh report.
  if (platform !== 'auto') {
    if (platform !== 'woocommerce') {
      const woo = await fetchWooCatalog(origin, log, fetchJson);
      if (woo.length) {
        log(`  ${origin} now looks like WooCommerce, not ${platform} — using that`);
        return { products: woo, platform: 'woocommerce' };
      }
    }
    if (platform !== 'shopify') {
      const shop = await fetchShopifyCatalog(origin, log, fetchJson);
      if (shop.length) {
        log(`  ${origin} now looks like Shopify, not ${platform} — using that`);
        return { products: shop, platform: 'shopify' };
      }
    }
    if (platform !== 'medusa' && (await looksLikeMedusa(site))) {
      log(`  ${origin} now looks like a Medusa storefront, not ${platform} — using that`);
      const products = await fetchMedusaCatalog(site, log);
      if (products.length) return { products, platform: 'medusa' };
    }
    // Fall through to the empty-catalogue check in fetchPartnerCatalog();
    // only `auto` means "we couldn't identify this site at all", which is a
    // different, more actionable message.
    return { products: [], platform };
  }
  if (await looksLikeMedusa(site)) {
    const products = await fetchMedusaCatalog(site, log);
    if (products.length) return { products, platform: 'medusa' };
  }
  throw new Error(
    `Could not read a product catalogue from ${origin}. Supported platforms: ` +
      `WooCommerce (/wp-json/wc/store/v1/products) and Shopify (/products.json). ` +
      `This site appears to use neither, so it needs a custom adapter.`,
  );
}
