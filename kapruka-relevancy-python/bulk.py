"""
Kapruka Relevancy Sorter — bulk.

Paste many Kapruka find_online URLs (one per line), click Run once, and every
link is loaded + AI-sorted in the background (small worker pool so a 1000-link
job doesn't hammer OpenAI all at once). Each product's photo + title is scored
0-100 for relevancy to its search term; the page polls for progress and shows
an overall relevancy score for the whole batch plus a per-link breakdown table
(so you can spot which search terms return the most irrelevant results).

Run:
    pip install -r requirements.txt
    python bulk.py
    open http://localhost:5001
"""

import json
import os
import re
import threading
import time
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
PAGE_SAFETY_CAP = 8
BATCH_SIZE = 10  # products per vision call
BULK_CONCURRENCY = int(os.environ.get("BULK_CONCURRENCY", "3"))  # links processed at once
HIGH_THRESHOLD = 70
LOW_THRESHOLD = 30

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

client = OpenAI(max_retries=5)  # reads OPENAI_API_KEY from env
app = Flask(__name__)

# ---------------------------------------------------------------------------
# Scraping — same approach as individual.py: read the JSON-LD <script> block
# Kapruka embeds per product card, and follow its own pagination.


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
            break
        page += 1

    return list(seen.values())[:limit]


# ---------------------------------------------------------------------------
# Relevancy scoring (OpenAI vision) — identical rubric to individual.py so
# scores are comparable across both tools.

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
    except Exception as err:  # noqa: BLE001
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
# Bulk job orchestration — an in-memory job per POST /api/bulk, processed by
# a small thread pool so many links run concurrently without unbounded
# parallel API calls. Polled via GET /api/bulk/<id>.

JOBS = {}
JOBS_LOCK = threading.Lock()


def round1(n):
    return round(n * 10) / 10


def run_one_link(link):
    link["status"] = "running"
    try:
        products = collect_products(link["url"])
        ranked = score_relevancy(link["term"], products)
        link["products"] = ranked
        link["productCount"] = len(ranked)
        link["avgRelevancy"] = (
            round1(sum(p["relevancyScore"] for p in ranked) / len(ranked)) if ranked else 0
        )
        link["highCount"] = sum(1 for p in ranked if p["relevancyScore"] >= HIGH_THRESHOLD)
        link["mediumCount"] = sum(
            1 for p in ranked if LOW_THRESHOLD <= p["relevancyScore"] < HIGH_THRESHOLD
        )
        link["lowCount"] = sum(1 for p in ranked if p["relevancyScore"] < LOW_THRESHOLD)
        link["status"] = "done"
    except Exception as err:  # noqa: BLE001
        link["status"] = "error"
        link["error"] = str(err)


def run_job(job):
    with ThreadPoolExecutor(max_workers=min(BULK_CONCURRENCY, len(job["links"]) or 1)) as pool:
        futures = [pool.submit(run_one_link, link) for link in job["links"]]
        for f in futures:
            f.result()
            job["completed"] += 1

    scored_links = [l for l in job["links"] if l["status"] == "done" and l["productCount"] > 0]
    total_products = sum(l["productCount"] for l in scored_links)
    weighted_sum = sum(l["avgRelevancy"] * l["productCount"] for l in scored_links)
    job["overallScore"] = round1(weighted_sum / total_products) if total_products else None
    job["status"] = "done"
    job["finishedAt"] = time.time()


def create_job(urls):
    job_id = f"{int(time.time())}-{os.urandom(4).hex()}"
    job = {
        "id": job_id,
        "status": "running",
        "total": len(urls),
        "completed": 0,
        "overallScore": None,
        "startedAt": time.time(),
        "finishedAt": None,
        "links": [
            {
                "url": url,
                "term": term_from_url(url),
                "status": "pending",
                "productCount": 0,
                "avgRelevancy": None,
                "highCount": 0,
                "mediumCount": 0,
                "lowCount": 0,
                "products": None,
                "error": None,
            }
            for url in urls
        ],
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return job


def job_summary(job):
    return {
        "id": job["id"],
        "status": job["status"],
        "total": job["total"],
        "completed": job["completed"],
        "overallScore": job["overallScore"],
        "links": [
            {
                "url": l["url"],
                "term": l["term"],
                "status": l["status"],
                "productCount": l["productCount"],
                "avgRelevancy": l["avgRelevancy"],
                "highCount": l["highCount"],
                "mediumCount": l["mediumCount"],
                "lowCount": l["lowCount"],
                "error": l["error"],
            }
            for l in job["links"]
        ],
    }


# ---------------------------------------------------------------------------
# Routes

INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Kapruka Bulk Relevancy Sorter</title>
<style>
:root { color-scheme: light dark; --bg:#fafafa; --card:#fff; --text:#1a1a1a; --muted:#666; --border:#e2e2e2; --accent:#7c3aed; --good:#16a34a; --mid:#d97706; --bad:#dc2626; }
@media (prefers-color-scheme: dark) { :root { --bg:#16161a; --card:#201f26; --text:#f2f2f2; --muted:#9a9aa5; --border:#33333d; } }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); padding:1.5rem 2rem 3rem; }
h1 { margin:0 0 0.25rem; font-size:1.5rem; }
h2 { font-size:1.1rem; margin:1.5rem 0 0.4rem; }
.sub { margin:0 0 1.25rem; color:var(--muted); font-size:0.9rem; }
code { background:var(--card); padding:0.1rem 0.35rem; border-radius:4px; }
textarea { width:100%; padding:0.7rem 0.8rem; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:0.9rem; font-family:inherit; resize:vertical; }
.toolbar { display:flex; gap:0.6rem; align-items:center; flex-wrap:wrap; margin:0.8rem 0 1.2rem; }
button { padding:0.55rem 1rem; border-radius:8px; border:1px solid var(--border); background:var(--card); color:var(--text); cursor:pointer; font-size:0.9rem; }
button:hover:not(:disabled) { border-color:var(--accent); }
button:disabled { opacity:0.5; cursor:not-allowed; }
#runBtn { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
.status { color:var(--muted); font-size:0.85rem; }
.overall-score { display:flex; align-items:center; gap:1rem; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:1rem 1.4rem; margin-bottom:1.2rem; }
.overall-score .score-value { font-size:2.4rem; font-weight:800; color:var(--accent); line-height:1; }
.overall-score .score-label { color:var(--muted); font-size:0.85rem; }
table.bulk-table { width:100%; border-collapse:collapse; margin-bottom:1.5rem; font-size:0.85rem; }
table.bulk-table th, table.bulk-table td { text-align:left; padding:0.5rem 0.6rem; border-bottom:1px solid var(--border); }
table.bulk-table tbody tr { cursor:pointer; }
table.bulk-table tbody tr:hover { background:rgba(124,58,237,0.08); }
.badge { display:inline-block; padding:0.05rem 0.45rem; border-radius:999px; font-weight:700; }
.badge.good { color:var(--good); } .badge.mid { color:var(--mid); } .badge.bad { color:var(--bad); }
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:1rem; }
.card { background:var(--card); border:1px solid var(--border); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; position:relative; }
.card img { width:100%; aspect-ratio:1/1; object-fit:cover; background:#eee; }
.card .body { padding:0.6rem 0.7rem 0.8rem; display:flex; flex-direction:column; gap:0.3rem; flex:1; }
.card .rank { position:absolute; top:0.4rem; left:0.4rem; background:rgba(0,0,0,0.65); color:#fff; font-size:0.75rem; padding:0.1rem 0.45rem; border-radius:999px; }
.card .score { position:absolute; top:0.4rem; right:0.4rem; background:var(--accent); color:#fff; font-size:0.75rem; font-weight:700; padding:0.1rem 0.45rem; border-radius:999px; }
.card .title { font-size:0.85rem; line-height:1.3; flex:1; text-decoration:none; color:var(--text); }
.card .price { font-size:0.85rem; font-weight:600; }
.card .reason { font-size:0.75rem; color:var(--muted); }
</style>
</head>
<body>
<h1>Kapruka Bulk Relevancy Sorter</h1>
<p class="sub">Paste many <code>find_online</code> links (one per line). Each is loaded and AI-sorted; you get an overall relevancy score for the whole batch plus a per-link breakdown (worst first).</p>

<textarea id="urls" rows="8" placeholder="https://www.kapruka.com/lk/find_online/almond&#10;https://www.kapruka.com/lk/find_online/cashew&#10;https://www.kapruka.com/lk/find_online/walnut"></textarea>
<div class="toolbar">
<button id="runBtn">Run Bulk AI Sort</button>
<span id="status" class="status"></span>
</div>

<div id="overall" class="overall-score" hidden>
<div class="score-value" id="overallValue">--</div>
<div class="score-label">overall relevancy score<br /><span id="overallSub"></span></div>
</div>

<table id="table" class="bulk-table" hidden>
<thead><tr><th>#</th><th>Term</th><th>Products</th><th>Avg Relevancy</th><th>High / Med / Low</th><th>Status</th></tr></thead>
<tbody id="tbody"></tbody>
</table>

<div id="detail" class="grid"></div>

<script>
const runBtn = document.getElementById('runBtn');
const statusEl = document.getElementById('status');
const overallEl = document.getElementById('overall');
const overallValue = document.getElementById('overallValue');
const overallSub = document.getElementById('overallSub');
const table = document.getElementById('table');
const tbody = document.getElementById('tbody');
const detail = document.getElementById('detail');
let pollTimer = null;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function band(score) {
  if (score == null) return '';
  if (score >= 70) return 'good';
  if (score >= 30) return 'mid';
  return 'bad';
}

function renderTable(links) {
  const rows = links.map((l, i) => ({ l, i })).sort((a, b) => {
    const av = a.l.avgRelevancy ?? -1, bv = b.l.avgRelevancy ?? -1;
    return av - bv; // worst-performing search terms first
  });
  tbody.innerHTML = rows.map(({ l, i }) => `
    <tr data-index="${i}">
      <td>${i + 1}</td>
      <td>${escapeHtml(l.term)}</td>
      <td>${l.productCount || ''}</td>
      <td><span class="badge ${band(l.avgRelevancy)}">${l.avgRelevancy ?? ''}</span></td>
      <td>${l.highCount}/${l.mediumCount}/${l.lowCount}</td>
      <td>${l.status}${l.error ? ': ' + escapeHtml(l.error) : ''}</td>
    </tr>
  `).join('');
  table.hidden = false;

  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', () => loadDetail(Number(tr.dataset.index)));
  });
}

async function loadDetail(index) {
  const jobId = runBtn.dataset.jobId;
  if (!jobId) return;
  detail.innerHTML = '<p class="status">Loading products...</p>';
  const res = await fetch(`/api/bulk/${jobId}/link/${index}`);
  const link = await res.json();
  if (!link.products) { detail.innerHTML = '<p class="status">No products for this link.</p>'; return; }
  detail.innerHTML = link.products.map((p, i) => `
    <div class="card">
      <span class="rank">#${i + 1}</span>
      <span class="score">${p.relevancyScore}</span>
      <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" loading="lazy" /></a>
      <div class="body">
        <a class="title" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
        <div class="price">${p.currency || ''} ${p.price != null ? Number(p.price).toLocaleString() : ''}</div>
        <div class="reason">${escapeHtml(p.reasoning)}</div>
      </div>
    </div>
  `).join('');
}

async function poll(jobId) {
  const res = await fetch(`/api/bulk/${jobId}`);
  const job = await res.json();
  renderTable(job.links);
  statusEl.textContent = `${job.completed}/${job.total} links processed (${job.status})`;

  if (job.overallScore != null) {
    overallEl.hidden = false;
    overallValue.textContent = job.overallScore;
    overallSub.textContent = `across ${job.links.reduce((s, l) => s + (l.productCount || 0), 0)} products, ${job.total} links`;
  }

  if (job.status === 'done') {
    clearInterval(pollTimer);
    runBtn.disabled = false;
  }
}

runBtn.addEventListener('click', async () => {
  const urls = document.getElementById('urls').value.split('\\n').map((s) => s.trim()).filter(Boolean);
  if (urls.length === 0) return;
  if (urls.length > 20 && !confirm(`About to AI-sort ${urls.length} links (~$0.03/link in OpenAI usage, roughly $${(urls.length * 0.03).toFixed(2)} total). Continue?`)) return;

  runBtn.disabled = true;
  overallEl.hidden = true;
  table.hidden = true;
  detail.innerHTML = '';
  statusEl.textContent = 'Starting job...';

  const res = await fetch('/api/bulk', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ urls }) });
  const data = await res.json();
  if (!res.ok) { statusEl.textContent = `Error: ${data.error}`; runBtn.disabled = false; return; }

  runBtn.dataset.jobId = data.jobId;
  pollTimer = setInterval(() => poll(data.jobId), 1500);
  poll(data.jobId);
});
</script>
</body>
</html>"""


@app.route("/")
def index():
    return INDEX_HTML


@app.route("/api/bulk", methods=["POST"])
def api_bulk_start():
    data = request.get_json(force=True) or {}
    urls = [str(u).strip() for u in (data.get("urls") or []) if str(u).strip()]
    if not urls:
        return jsonify({"error": "Provide a non-empty list of urls."}), 400
    bad = next((u for u in urls if "kapruka.com" not in u.lower()), None)
    if bad:
        return jsonify({"error": f"Not a kapruka.com link: {bad}"}), 400
    job = create_job(urls)
    return jsonify({"jobId": job["id"]})


@app.route("/api/bulk/<job_id>")
def api_bulk_status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job_summary(job))


@app.route("/api/bulk/<job_id>/link/<int:index>")
def api_bulk_link(job_id, index):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    if index < 0 or index >= len(job["links"]):
        return jsonify({"error": "Link not found"}), 404
    return jsonify(job["links"][index])


if __name__ == "__main__":
    port = int(os.environ.get("BULK_PORT", "5001"))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
