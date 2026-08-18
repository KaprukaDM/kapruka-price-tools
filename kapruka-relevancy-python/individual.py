"""
Kapruka Relevancy Sorter — single link.

Paste one Kapruka find_online URL, load its current listing (up to 60
products, pulled from the JSON-LD Kapruka embeds per product card — reliable
title/link/image/price extraction, no vision needed for that part), then
click "AI Sort" to have OpenAI vision score each product's photo + title for
relevancy to the search term and re-sort the grid.

Run:
    pip install -r requirements.txt
    python individual.py
    open http://localhost:5000
"""

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from flask import Flask, jsonify, request
from openai import OpenAI

load_dotenv()

MODEL = os.environ.get("RELEVANCY_MODEL", "gpt-4o-mini")
PRODUCT_LIMIT = int(os.environ.get("RELEVANCY_LIMIT", "60"))
PAGE_SAFETY_CAP = 8  # hard stop even if the site keeps returning "new" pages
BATCH_SIZE = 10  # products per vision call

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

client = OpenAI(max_retries=5)  # reads OPENAI_API_KEY from env
app = Flask(__name__)

# ---------------------------------------------------------------------------
# Scraping — reads the JSON-LD <script> block Kapruka embeds per product card.


def fetch_listing_html(url, referer=None):
    headers = {
        "User-Agent": UA,
        "Accept-Language": "en-LK,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    if referer:
        headers["Referer"] = referer
        headers["X-Requested-With"] = "XMLHttpRequest"
    res = requests.get(url, headers=headers, timeout=20)
    res.raise_for_status()
    return res.text


def parse_listing_products(html_text):
    soup = BeautifulSoup(html_text, "html.parser")
    products = []
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = script.string or script.text
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        nodes = data if isinstance(data, list) else [data]
        for node in nodes:
            if not isinstance(node, dict) or node.get("@type") != "Product":
                continue
            offers = node.get("offers")
            offer = offers[0] if isinstance(offers, list) and offers else (offers or {})
            image = node.get("image")
            image = image[0] if isinstance(image, list) and image else image
            price = offer.get("price")
            products.append(
                {
                    "title": node.get("name"),
                    "url": node.get("url"),
                    "image": image,
                    "price": float(price) if price is not None else None,
                    "currency": offer.get("priceCurrency"),
                }
            )
    return products


def find_pagination_template(html_text, base_url):
    """Kapruka's "See More Products" button carries the exact pagination URL
    template in its onclick handler — reuse it verbatim instead of guessing."""
    m = re.search(r"paginate\('([^']+)'\)", html_text)
    return urljoin(base_url, m.group(1)) if m else None


def with_page(template_url, page):
    parsed = urlparse(template_url)
    qs = parse_qs(parsed.query)
    qs["p"] = [str(page)]
    return urlunparse(parsed._replace(query=urlencode(qs, doseq=True)))


def term_from_url(url):
    m = re.search(r"find_online/([^/?#]+)", url, re.IGNORECASE)
    return unquote(m.group(1)) if m else "results"


def collect_products(listing_url, limit=PRODUCT_LIMIT):
    seen = {}
    first_html = fetch_listing_html(listing_url)
    for p in parse_listing_products(first_html):
        if p["url"]:
            seen[p["url"]] = p

    template = find_pagination_template(first_html, listing_url)
    page = 2
    while template and len(seen) < limit and page <= PAGE_SAFETY_CAP:
        page_url = with_page(template, page)
        try:
            page_html = fetch_listing_html(page_url, referer=listing_url)
        except requests.RequestException:
            break
        before = len(seen)
        for p in parse_listing_products(page_html):
            if p["url"] and p["url"] not in seen:
                seen[p["url"]] = p
        if len(seen) == before:
            break  # ran out of results
        page += 1

    return list(seen.values())[:limit]


# ---------------------------------------------------------------------------
# Relevancy scoring (OpenAI vision)

REPORT_RELEVANCY_FN = {
    "name": "report_relevancy",
    "description": "Report how relevant each numbered product (photo + title) is to the search term.",
    "parameters": {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "index": {"type": "integer", "description": "The item number given in the prompt."},
                        "relevancyScore": {
                            "type": "integer",
                            "description": (
                                "0-100, using the full range — do not cluster items at the same round "
                                "number. The product that literally IS the search term (standalone — "
                                "e.g. a bag of plain almonds, or a USB flash drive for a \"drive\" "
                                "search) scores highest. A close mix/bundle/variant that still centers "
                                "on the term scores next. A manufactured product that merely uses the "
                                "term as a flavor/feature (e.g. an almond cake) scores lower than that, "
                                "and a minor/secondary mention scores lower still. Lowest scores for "
                                "items that only surfaced because the term appears loosely in the "
                                "title/description (unrelated products, accessories, or gift hampers "
                                "that merely mention the word)."
                            ),
                        },
                        "reasoning": {"type": "string", "description": "One short sentence."},
                    },
                    "required": ["index", "relevancyScore", "reasoning"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["items"],
        "additionalProperties": False,
    },
}


def score_batch(term, batch):
    content = [
        {
            "type": "text",
            "text": (
                f'A shopper searched Kapruka.com for "{term}". Below are {len(batch)} product results, '
                "each with its photo and title. Score how relevant each one actually is to that search, "
                "looking at the photo as well as the title. The search term could be a food ingredient, "
                "an electronics category, a cosmetic, or anything else Kapruka sells — judge relevance "
                "to what a shopper actually means by the term, not just literal ingredient-list "
                "matching.\n\n"
                "Use this rubric and spread scores across it — do not give everything the same number:\n"
                f'- 90-100: the product IS "{term}" — the exact, standalone item a shopper searching '
                'this term wants (e.g. a bag of plain almonds for "almond", a USB flash drive for '
                '"drive").\n'
                f'- 70-89: a close match — a mix, bundle, or variant that still centers on "{term}" '
                "(e.g. a mixed-nut snack where it is a featured ingredient, a different size/model/"
                "capacity of the same core item).\n"
                f'- 40-69: a manufactured or derived product where "{term}" is a headline flavor/'
                "feature, but the product itself is something else (e.g. an almond-flavored cake, a "
                "walnut coffee).\n"
                f'- 15-39: "{term}" is present only as a minor or secondary ingredient/feature, not '
                "the headline.\n"
                "- 0-14: barely related — mentioned in passing, or an unrelated product/accessory/gift "
                "hamper that just happens to include the word.\n"
                "Within each band, differentiate further based on pack size/capacity, purity, and how "
                "central the term is to the product. Call report_relevancy with one entry per item."
            ),
        }
    ]
    for i, p in enumerate(batch):
        price_part = f" — {p.get('currency') or ''} {p['price']}" if p.get("price") else ""
        content.append({"type": "text", "text": f'Item {i}: "{p.get("title") or "(no title)"}"{price_part}'})
        if p.get("image"):
            # detail: 'low' fixes each image at a flat token cost instead of the
            # much pricier high-detail tiling — plenty for a product thumbnail.
            content.append({"type": "image_url", "image_url": {"url": p["image"], "detail": "low"}})

    try:
        res = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": content}],
            tools=[{"type": "function", "function": REPORT_RELEVANCY_FN}],
            tool_choice={"type": "function", "function": {"name": "report_relevancy"}},
        )
        call = res.choices[0].message.tool_calls[0]
        items = json.loads(call.function.arguments)["items"]
        by_index = {it["index"]: it for it in items}
        return [
            by_index.get(i, {"relevancyScore": 0, "reasoning": "missing from report"})
            for i in range(len(batch))
        ]
    except Exception as err:  # noqa: BLE001 — surface any failure as a score of 0
        return [{"relevancyScore": 0, "reasoning": f"error: {err}"} for _ in batch]


def score_relevancy(term, products):
    batches = [products[i : i + BATCH_SIZE] for i in range(0, len(products), BATCH_SIZE)]
    if not batches:
        return []
    with ThreadPoolExecutor(max_workers=min(len(batches), 6)) as pool:
        scored = list(pool.map(lambda b: score_batch(term, b), batches))

    merged = []
    for i, p in enumerate(products):
        b_idx, w_idx = divmod(i, BATCH_SIZE)
        s = scored[b_idx][w_idx] if b_idx < len(scored) else {}
        merged.append({**p, "relevancyScore": s.get("relevancyScore", 0), "reasoning": s.get("reasoning", "")})
    merged.sort(key=lambda p: p["relevancyScore"], reverse=True)
    return merged


# ---------------------------------------------------------------------------
# Routes

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Kapruka Relevancy Sorter</title>
<style>
:root { color-scheme: light dark; --bg:#fafafa; --card:#fff; --text:#1a1a1a; --muted:#666; --border:#e2e2e2; --accent:#7c3aed; }
@media (prefers-color-scheme: dark) { :root { --bg:#16161a; --card:#201f26; --text:#f2f2f2; --muted:#9a9aa5; --border:#33333d; } }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); padding:1.5rem 2rem 3rem; }
h1 { margin:0 0 0.25rem; font-size:1.5rem; }
.sub { margin:0 0 1.25rem; color:var(--muted); font-size:0.9rem; }
code { background:var(--card); padding:0.1rem 0.35rem; border-radius:4px; }
.toolbar { display:flex; gap:0.6rem; align-items:center; flex-wrap:wrap; margin-bottom:1.5rem; }
input[type=url] { flex:1 1 380px; padding:0.55rem 0.8rem; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:0.95rem; }
button { padding:0.55rem 1rem; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); cursor:pointer; font-size:0.9rem; }
button:hover:not(:disabled) { border-color:var(--accent); }
button:disabled { opacity:0.5; cursor:not-allowed; }
#sortBtn { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
.status { color:var(--muted); font-size:0.85rem; }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:1rem; }
.card { background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; position:relative; }
.card img { width:100%; aspect-ratio:1/1; object-fit:cover; background:#eee; }
.card .body { padding:0.6rem 0.7rem 0.8rem; display:flex; flex-direction:column; gap:0.3rem; flex:1; }
.card .rank { position:absolute; top:0.4rem; left:0.4rem; background:rgba(0,0,0,0.65); color:#fff; font-size:0.75rem; padding:0.1rem 0.45rem; border-radius:999px; }
.card .score { position:absolute; top:0.4rem; right:0.4rem; background:var(--accent); color:#fff; font-size:0.75rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:999px; }
.card .title { font-size:0.85rem; line-height:1.3; flex:1; text-decoration:none; color:var(--text); }
.card .title:hover { text-decoration:underline; }
.card .price { font-size:0.85rem; font-weight:600; }
.card .reason { font-size:0.75rem; color:var(--muted); }
</style>
</head>
<body>
<header>
<h1>Kapruka Relevancy Sorter</h1>
<p class="sub">Paste a Kapruka <code>find_online</code> link, load the current listing, then let AI re-sort it by relevancy.</p>
</header>

<form id="loadForm" class="toolbar">
<input id="urlInput" type="url" placeholder="https://www.kapruka.com/lk/find_online/almond" required />
<button id="loadBtn" type="submit">Load</button>
<button id="sortBtn" type="button" disabled>AI Sort by Relevancy</button>
<span id="status" class="status"></span>
</form>

<div id="grid" class="grid"></div>

<script>
const form = document.getElementById('loadForm');
const urlInput = document.getElementById('urlInput');
const loadBtn = document.getElementById('loadBtn');
const sortBtn = document.getElementById('sortBtn');
const statusEl = document.getElementById('status');
const grid = document.getElementById('grid');

let state = { term: null, sourceUrl: null, products: [] };

function setStatus(msg) { statusEl.textContent = msg || ''; }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatPrice(p) {
  if (p.price == null) return '';
  return `${p.currency || ''} ${Number(p.price).toLocaleString()}`.trim();
}

function render(products, sorted) {
  grid.innerHTML = products.map((p, i) => `
    <div class="card">
      <span class="rank">#${i + 1}</span>
      ${sorted ? `<span class="score">${p.relevancyScore}</span>` : ''}
      <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">
        <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" loading="lazy" />
      </a>
      <div class="body">
        <a class="title" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
        <div class="price">${escapeHtml(formatPrice(p))}</div>
        ${sorted ? `<div class="reason">${escapeHtml(p.reasoning)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  loadBtn.disabled = true; sortBtn.disabled = true; setStatus('Loading listing...'); grid.innerHTML = '';
  try {
    const res = await fetch('/api/fetch', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load listing');
    state = { term: data.term, sourceUrl: data.sourceUrl, products: data.products };
    render(state.products, false);
    setStatus(`Loaded ${state.products.length} products for "${state.term}"`);
    sortBtn.disabled = state.products.length === 0;
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    loadBtn.disabled = false;
  }
});

sortBtn.addEventListener('click', async () => {
  if (!state.products.length) return;
  sortBtn.disabled = true; loadBtn.disabled = true;
  setStatus('Asking AI to score relevancy (looking at photos + titles)...');
  try {
    const res = await fetch('/api/sort', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ term: state.term, products: state.products }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to sort');
    state.products = data.products;
    render(state.products, true);
    setStatus(`Sorted ${state.products.length} products by relevancy to "${state.term}"`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    sortBtn.disabled = false; loadBtn.disabled = false;
  }
});
</script>
</body>
</html>"""


@app.route("/")
def index():
    return INDEX_HTML


@app.route("/api/fetch", methods=["POST"])
def api_fetch():
    data = request.get_json(force=True) or {}
    url = (data.get("url") or "").strip()
    if not url or "kapruka.com" not in url.lower():
        return jsonify({"error": "Paste a valid kapruka.com find_online link."}), 400
    try:
        term = term_from_url(url)
        products = collect_products(url)
        return jsonify({"term": term, "sourceUrl": url, "products": products})
    except Exception as err:  # noqa: BLE001
        return jsonify({"error": str(err)}), 500


@app.route("/api/sort", methods=["POST"])
def api_sort():
    data = request.get_json(force=True) or {}
    term = data.get("term")
    products = data.get("products")
    if not term or not products:
        return jsonify({"error": "Missing term or products to sort."}), 400
    try:
        ranked = score_relevancy(term, products)
        return jsonify({"term": term, "products": ranked})
    except Exception as err:  # noqa: BLE001
        return jsonify({"error": str(err)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("INDIVIDUAL_PORT", os.environ.get("PORT", "5000")))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
