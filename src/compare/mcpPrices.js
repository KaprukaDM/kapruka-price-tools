import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium } from "playwright";

const MCP_URL = process.env.KAPRUKA_MCP_URL || "https://mcp.kapruka.com/mcp";
const DELAY_MS = Number(process.env.KAPRUKA_MCP_DELAY_MS || 300);
const LK_WAIT_MS = Number(process.env.KAPRUKA_LK_WAIT_MS || 3000);
const MAX_PRODUCTS = Number(process.env.KAPRUKA_MCP_MAX_PRODUCTS || 200);
const SAME_PRICE_TOLERANCE = 0.01;

let clientPromise;
let browserPromise;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client({
        name: "kapruka-price-tools",
        version: "1.0.0"
      });

      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
      await client.connect(transport);
      return client;
    })();
  }

  return clientPromise;
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true
    });
  }

  return browserPromise;
}

function toLkKaprukaUrl(url) {
  const s = String(url || "");

  if (!s.includes("kapruka.com")) return s;
  if (s.includes("/lk/buyonline/")) return s;

  return s.replace(
    "https://www.kapruka.com/buyonline/",
    "https://www.kapruka.com/lk/buyonline/"
  );
}

function parseMainLkrPrice(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (/per month/i.test(line)) continue;

    const m =
      line.match(/^(?:Rs\.?|RS\.?|LKR)\s*\.?\s*([\d,]+)/i) ||
      line.match(/^රු\.?\s*([\d,]+)/i);

    if (!m) continue;

    const n = parseInt(m[1].replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

async function scrapeKaprukaLkPagePrice(kaprukaUrl, log) {
  const url = toLkKaprukaUrl(kaprukaUrl);
  const browser = await getBrowser();
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    viewport: { width: 1366, height: 768 }
  });

  try {
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();

      if (["image", "font", "media"].includes(type)) {
        return route.abort();
      }

      return route.continue();
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    await page.waitForTimeout(LK_WAIT_MS);

    const text = await page.locator("body").innerText({ timeout: 30000 });
    const price = parseMainLkrPrice(text);

    if (price != null) {
      log(`LK page price loaded: ${url} = LKR ${price}`);
      return price;
    }

    log(`LK page price missing: ${url}`);
    return null;
  } catch (err) {
    log(`LK page price failed: ${url} - ${err.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

function normalizeText(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/BLACK\s*\+\s*DECKER/g, "BLACK DECKER")
    .replace(/BLACK\s*&\s*DECKER/g, "BLACK DECKER")
    .replace(/BLACK\s+AND\s+DECKER/g, "BLACK DECKER")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function extractModelCodes(...texts) {
  const joined = normalizeText(texts.join(" "));

  const matches =
    joined.match(/\b[A-Z]{1,8}\d{2,5}[A-Z]*(?:-[A-Z0-9]{1,4})?\b/g) || [];

  const ignore = new Set([
    "1800W", "1600W", "1400W", "1200W", "900W", "750W", "600W", "550W",
    "500W", "400W", "300W", "2400W", "2200W", "1750W", "1950W",
    "70L", "55L", "45L", "35L", "25L", "20L", "19L", "16L", "10L",
    "9L", "3L", "2L", "1L"
  ]);

  return [...new Set(matches.filter((x) => !ignore.has(x)))];
}

function parseSearchCandidates(text) {
  const s = String(text || "");
  const parts = s.split(/\n(?=\*\*\d+\.\s)/g);
  const candidates = [];

  for (const part of parts) {
    const title = part.match(/\*\*\d+\.\s*(.*?)\*\*/s)?.[1] || "";
    const id = part.match(/ID:\s*`([^`]+)`/i)?.[1] || "";
    const priceRaw = part.match(/\bLKR\s*([\d,]+)/i)?.[1] || "";
    const url = part.match(/\[View product\]\(([^)]+)\)/i)?.[1] || "";
    const price = priceRaw ? parseInt(priceRaw.replace(/,/g, ""), 10) : null;

    if (title && Number.isFinite(price)) {
      candidates.push({ title, id, price, url, raw: part });
    }
  }

  return candidates;
}

async function searchMcp(query) {
  const client = await getClient();

  const result = await client.callTool({
    name: "kapruka_search_products",
    arguments: {
      params: {
        q: query,
        currency: "LKR",
        limit: 5,
        in_stock_only: false
      }
    }
  });

  const text =
    result?.structuredContent?.result ||
    result?.content?.map((c) => c.text || "").join("\n") ||
    "";

  return parseSearchCandidates(text);
}

async function getSafeMcpPrice(row, log) {
  const codes = extractModelCodes(row.name, row.partnerName, row.partnerSku);

  if (!codes.length) {
    log(`MCP skipped: no model code for "${row.name}"`);
    return null;
  }

  for (const code of codes) {
    const candidates = await searchMcp(code);

    for (const c of candidates) {
      const title = normalizeText(c.title);
      const raw = normalizeText(c.raw);

      if (!title.includes(code) && !raw.includes(code)) {
        continue;
      }

      log(`MCP fallback accepted: ${code} = LKR ${c.price}`);
      return c.price;
    }

    log(`MCP no safe match for code "${code}"`);
  }

  return null;
}

function priceComparison(kaprukaPrice, partnerPrice) {
  if (kaprukaPrice == null || partnerPrice == null) {
    return { verdict: "price_missing", diff: null, pct: null };
  }

  const diff = kaprukaPrice - partnerPrice;
  const pct = partnerPrice ? (diff / partnerPrice) * 100 : null;

  let verdict;
  if (Math.abs(diff) <= partnerPrice * SAME_PRICE_TOLERANCE) {
    verdict = "same";
  } else if (diff > 0) {
    verdict = "kapruka_higher";
  } else {
    verdict = "kapruka_lower";
  }

  return { verdict, diff, pct };
}

function recomputeSummary(result) {
  const matched = result.matched || [];

  return {
    matched: matched.length,
    same: matched.filter((x) => x.verdict === "same").length,
    kaprukaHigher: matched.filter((x) => x.verdict === "kapruka_higher").length,
    kaprukaLower: matched.filter((x) => x.verdict === "kapruka_lower").length,
    priceMissing: matched.filter((x) => x.verdict === "price_missing").length,
    onlyKapruka: (result.onlyKapruka || []).length,
    onlyPartner: (result.onlyPartner || []).length
  };
}

export async function hydrateComparisonResultFromMcp(result, { log = () => {} } = {}) {
  if (process.env.USE_KAPRUKA_MCP !== "1") {
    return { checked: 0, updated: 0, skipped: true };
  }

  let checked = 0;
  let updated = 0;
  let lkUpdated = 0;
  let mcpUpdated = 0;
  let rejected = 0;

  for (const row of result.matched || []) {
    if (checked >= MAX_PRODUCTS) break;
    if (row.kaprukaPrice != null) continue;

    if (checked > 0) await sleep(DELAY_MS);
    checked++;

    try {
      let price = await scrapeKaprukaLkPagePrice(row.kaprukaUrl, log);

      if (price != null) {
        lkUpdated++;
      } else {
        price = await getSafeMcpPrice(row, log);
        if (price != null) mcpUpdated++;
      }

      if (price != null) {
        row.kaprukaPrice = price;
        Object.assign(row, priceComparison(row.kaprukaPrice, row.partnerPrice));
        updated++;
      } else {
        rejected++;
      }
    } catch (err) {
      rejected++;
      log(`Price hydrate failed for "${row.name}": ${err.message}`);
    }
  }

  result.summary = recomputeSummary(result);

  return {
    checked,
    updated,
    lkUpdated,
    mcpUpdated,
    rejected,
    skipped: false
  };
}