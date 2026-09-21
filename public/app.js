const $ = (id) => document.getElementById(id);

const STATUS_LABEL = {
  ok: { text: '✅ ok', cls: 'status-ok' },
  currency_mismatch: { text: '⚠️ currency mismatch', cls: 'status-warn' },
  price_not_found: { text: '⚠️ no price found', cls: 'status-warn' },
  variant_unavailable: { text: '⚠️ variant not sold here', cls: 'status-warn' },
  low_confidence: { text: '⚠️ low confidence', cls: 'status-warn' },
  no_result: { text: '— no match found', cls: 'status-warn' },
  error: { text: '⚠️ error', cls: 'status-warn' },
};

function fmtPrice(r) {
  if (r.price == null) return '—';
  const n = Number(r.price).toLocaleString('en-LK');
  const cur = r.currency || '';
  const approx = (r.flags || []).includes('price_approx') ? '~' : '';
  return `${approx}${cur} ${n}`.trim();
}

function badge(rate) {
  if (rate == null) return `<span class="badge b-lo">approx</span>`;
  const cls = rate >= 75 ? 'b-hi' : rate >= 50 ? 'b-md' : 'b-lo';
  return `<span class="badge ${cls}">${rate}%</span>`;
}

// Where a row came from, shown per row now that one table mixes our own
// scraped catalogue with a live web search (and Daraz). 'database' rows are
// periodically refreshed, not this second's price — that caveat is repeated
// under the table too.
const SOURCE_LABEL = {
  database: { text: 'our database', cls: 'b-md', title: 'From our own scraped/matched catalogue — refreshed periodically, not a live fetch.' },
  curated: { text: 'live web', cls: 'b-hi', title: 'Fetched live just now from a curated Sri Lankan shop.' },
  web: { text: 'live web', cls: 'b-hi', title: 'Fetched live just now from a web-search result.' },
  daraz: { text: 'Daraz (live)', cls: 'b-hi', title: 'Fetched live just now from the Daraz.lk marketplace.' },
};
function sourceBadge(r) {
  const s = SOURCE_LABEL[r.source] || SOURCE_LABEL.web;
  const broad = r.matchKind === 'broad'
    ? ` <span class="badge b-lo" title="Matched on the product name alone — no shared model code or spec to confirm it.">name match</span>`
    : '';
  return `<span class="badge ${s.cls}" title="${escapeHtml(s.title)}">${s.text}</span>${broad}`;
}

function buildTable(list, { showSource = false } = {}) {
  const rows = list
    .map((r) => {
      const st = STATUS_LABEL[r.status] || STATUS_LABEL.error;
      const overseasBadge = (r.flags || []).includes('overseas')
        ? ` <span class="badge b-md" title="Ships from outside Sri Lanka">overseas</span>`
        : '';
      const title = (r.title
        ? `${r.url ? `<a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>` : escapeHtml(r.title)}`
        : (r.url ? `<a href="${r.url}" target="_blank" rel="noopener">view page</a>` : '—')) + overseasBadge;
      const ctx = r.priceContext ? `<div class="ctx">${escapeHtml(r.priceContext)}</div>` : '';
      const note = r.note ? `<div class="ctx">${escapeHtml(r.note)}</div>` : '';
      // Show the model's reasoning when the match is weak, so you know WHY.
      const reason =
        (r.matchRate ?? 0) < 40 && r.reasoning
          ? `<div class="ctx reason">Why: ${escapeHtml(r.reasoning)}</div>`
          : '';
      // Only Daraz rows currently carry an image (its live feed returns one
      // per listing) -- the database-sourced rows (price_audit_items/
      // competitor_products/comparison_runs) don't store one at all, so this
      // is simply absent there rather than broken. onerror hides a dead
      // thumbnail instead of leaving a broken-image icon in the table.
      const thumb = r.image
        ? `<img src="${escapeHtml(r.image)}" alt="" loading="lazy" onerror="this.remove()" style="width:40px;height:40px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px">`
        : '';
      // Which Kapruka product this row was matched through — only set (and
      // only worth showing) when the query covered more than one Kapruka SKU.
      const via = showSource && r.via ? `<div class="ctx">vs Kapruka: ${escapeHtml(r.via)}</div>` : '';
      return `<tr>
        <td><strong>${escapeHtml(r.site)}</strong><div class="ctx">${escapeHtml(r.domain || '')}</div></td>
        <td>${thumb}${title}${reason}${via}</td>
        <td><span class="price">${fmtPrice(r)}</span>${ctx}</td>
        <td>${badge(r.matchRate)}</td>
        ${showSource ? `<td>${sourceBadge(r)}</td>` : ''}
        <td class="${st.cls}">${st.text}${note}</td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr>
      <th>Site</th><th>Matched product</th><th>Price</th><th>Match rate</th>${showSource ? '<th>Source</th>' : ''}<th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

// Set by run() when a Kapruka product URL was resolved, so render() can show
// the Kapruka price itself as a reference alongside the matched competitor
// prices. Cleared whenever a plain name/description search runs instead.
let kaprukaRef = null;

function kaprukaRefBlock(ref) {
  if (!ref) return '';
  const priceHtml = ref.price != null ? fmtPrice(ref) : 'price not found';
  return `<div class="card" style="margin-bottom:16px">
    <div class="ctx">Kapruka price</div>
    <div><strong><span class="price">${priceHtml}</span></strong>
      — <a href="${escapeHtml(ref.url)}" target="_blank" rel="noopener">${escapeHtml(ref.name || 'view on Kapruka')}</a>
    </div>
  </div>`;
}

// Automatic AI "what should Kapruka's price actually be" call -- runs
// server-side on every search that turns up at least one competitor price,
// whether or not Kapruka already sells the product (see price-insight.js),
// so this just renders whatever the response already carries, no separate
// request.
const PRICE_INSIGHT_LABEL = {
  overpriced: { text: '⚠️ Overpriced vs market', cls: 'status-warn' },
  competitive: { text: '✓ Competitive', cls: 'status-ok' },
  underpriced: { text: '💰 Underpriced vs market', cls: 'status-ok' },
  not_listed: { text: '🆕 Not currently sold on Kapruka', cls: 'status-warn' },
};
function priceInsightBlock(insight) {
  if (!insight) return '';
  const label = PRICE_INSIGHT_LABEL[insight.verdict] || PRICE_INSIGHT_LABEL.competitive;
  const ideal = insight.idealPriceLkr != null
    ? `LKR ${Number(insight.idealPriceLkr).toLocaleString('en-LK')}`
    : '—';
  const priceLabel = insight.verdict === 'not_listed' ? 'suggested launch price' : 'suggested price';
  return `<div class="card" style="margin-bottom:16px">
    <div class="ctx">🤖 AI price insight</div>
    <div style="margin-top:2px"><span class="${label.cls}">${label.text}</span>
      — ${priceLabel}: <strong><span class="price">${ideal}</span></strong></div>
    ${insight.reasoning ? `<div class="ctx" style="margin-top:6px">${escapeHtml(insight.reasoning)}</div>` : ''}
  </div>`;
}

// A short query ("playstation 5") can legitimately cover more than one
// Kapruka SKU — the 1TB Slim disc console and the "Slim Disc And Digital
// Version" listing are genuinely different products at different prices.
// Say that plainly above the table instead of silently answering about
// whichever one happened to score highest.
function kaprukaCandidatesBlock(candidates, ref) {
  const list = (candidates || []).filter((c) => c && c.url);
  if (list.length < 2) return '';
  const rows = list
    .map((c) => {
      const price = c.price != null ? `Rs. ${Number(c.price).toLocaleString('en-LK')}` : 'price not listed';
      const isRef = ref && ref.url === c.url ? ' <span class="badge b-hi">used for the insight above</span>' : '';
      // Only the audited candidates carry a match rate; the ones resolved
      // live from Kapruka's own search don't, and showing them an "approx"
      // badge (what badge(null) renders) would read as a scored match.
      const rate = c.matchRate != null ? ` ${badge(c.matchRate)}` : '';
      return `<li><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${escapeHtml(c.name)}</a>
        — <span class="price">${price}</span>${rate}${isRef}</li>`;
    })
    .join('');
  return `<div class="card" style="margin-bottom:16px">
    <div class="ctx">Your search matched ${list.length} different Kapruka listings</div>
    <ul style="margin:6px 0 0 18px;padding:0">${rows}</ul>
    <div class="ctx" style="margin-top:6px">These are separate Kapruka products, not duplicates —
      competitor rows below say which one they were matched against.</div>
  </div>`;
}

function render(data) {
  const out = $('out');
  const results = data.results || [];
  const discovered = data.discovered || [];
  // Prefer the ref resolved server-side for this search (a plain name-typed
  // query that hit a database single-mode match) over the client-tracked
  // one (set only when the user pasted a Kapruka URL) -- both represent the
  // same thing, this just covers the case the server can now also supply it.
  const ref = data.kaprukaRef || kaprukaRef;
  // searchDaraz() tries several query variations and can return several
  // matches (e.g. the same helmet from more than one seller) — filter out
  // the error/no_result placeholder entries, everything else is a real row.
  const darazRows = (data.daraz || []).filter((r) => r.status && r.status !== 'error' && r.status !== 'no_result');
  if (results.length === 0 && discovered.length === 0 && darazRows.length === 0) {
    out.innerHTML = kaprukaRefBlock(ref) + '<p class="empty">No results.</p>';
    return;
  }
  let html = kaprukaRefBlock(ref)
    + priceInsightBlock(data.priceInsight)
    + kaprukaCandidatesBlock(data.kaprukaCandidates, ref);
  // One table, every source: our own catalogue AND a live web search run on
  // the same query, de-duplicated per listing and sorted strongest-match
  // first. Which source a row came from is a column, not a separate section —
  // the old either/or split meant the answer changed depending on how the
  // query was phrased.
  const dbCount = data.dbCount != null ? data.dbCount : results.filter((r) => r.source === 'database').length;
  const webCount = data.webCount != null ? data.webCount : results.filter((r) => r.source !== 'database').length;
  if (results.length) {
    html += `<h3 style="margin:24px 0 4px">All matches (${results.length})</h3>
      <p class="note" style="margin-top:0">${dbCount} from our database · ${webCount} from a live web search,
        merged and de-duplicated. Strongest match first.</p>`
      + buildTable(results, { showSource: true });
    html += `<p class="note" style="margin-top:14px">
      <strong>our database</strong> rows come from our own scraped/matched catalogue, not a live fetch —
      refreshed periodically, not guaranteed to be this second's price.
      <strong>live web</strong> rows were pulled just now; a non-LKR currency means the site geo-rendered for
      a different region, and web-search results exclude Daraz, Big Deals, ikman, Facebook and foreign sites
      (Daraz is checked separately below).
      Click through to verify before acting on any of it.
    </p>`;
  }
  if (data.webError) {
    html += `<p class="note" style="margin-top:0">⚠️ The live web search returned nothing this time
      (${escapeHtml(data.webError)}) — the rows above are database-only, so treat the prices as
      periodically refreshed rather than live.</p>`;
  }
  if (darazRows.length) {
    html += `<h3 style="margin:24px 0 4px">Daraz.lk (live marketplace search)</h3>` + buildTable(darazRows);
    html += `<p class="note" style="margin-top:14px">
      Marketplace listings from third-party sellers, matched by name — not our own catalogue.
      Verify the seller and stock before buying.
    </p>`;
  } else {
    // Previously this whole section just silently vanished when the Daraz
    // lookup failed (network error, Daraz blocking the request, or every
    // query variation striking out), leaving no way to tell "nothing
    // matched" apart from "the lookup itself broke". Surface it instead.
    const darazError = (data.daraz || []).find((r) => r.status === 'error');
    if (darazError) {
      html += `<h3 style="margin:24px 0 4px">Daraz.lk (live marketplace search)</h3>
        <p class="note" style="margin-top:0">⚠️ Daraz search failed: ${escapeHtml(darazError.note || 'unknown error')}</p>`;
    }
  }
  out.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

function statusText(r) {
  const st = STATUS_LABEL[r.status] || STATUS_LABEL.error;
  return `<span class="${st.cls}">${st.text}</span>`;
}

function progressShell() {
  return `<div class="card">
    <p class="empty" style="margin:0"><span class="spin"></span>Searching, scraping and scoring across sites…</p>
    <div class="pbar"><span id="pbarFill"></span></div>
    <div id="pcount" class="ctx">Starting…</div>
    <div id="plist" class="plist"></div>
  </div>`;
}

let es = null;
let searchMode = 'search'; // 'search' | 'url'

function setSearchMode(mode) {
  searchMode = mode;
  $('modeSearch').classList.toggle('active', mode === 'search');
  $('modeSearch').setAttribute('aria-selected', String(mode === 'search'));
  $('modeUrl').classList.toggle('active', mode === 'url');
  $('modeUrl').setAttribute('aria-selected', String(mode === 'url'));
  $('searchFields').style.display = mode === 'search' ? '' : 'none';
  $('urlFields').style.display = mode === 'url' ? '' : 'none';
  $('hint').textContent = '';
}

// In URL mode, resolve the pasted Kapruka product link into a name/description
// first (via /api/kapruka/resolve), then hand off to the normal streaming
// match exactly as if the user had typed those fields in themselves.
async function resolveProductUrl() {
  const url = $('productUrl').value.trim();
  if (!url) {
    $('hint').textContent = ' Paste a Kapruka product URL first.';
    return null;
  }
  const res = await fetch('/api/kapruka/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await res.json();
  if (!res.ok) {
    $('hint').textContent = ' ' + (data.error || 'Could not read that product page.');
    return null;
  }
  $('name').value = data.name || '';
  $('description').value = data.description || '';
  return data;
}

// Stream the match over Server-Sent Events so we can show live progress
// (which/how many sites are done) instead of a silent ~60s wait.
async function run() {
  kaprukaRef = null;
  if (searchMode === 'url') {
    $('go').disabled = true;
    const product = await resolveProductUrl();
    $('go').disabled = false;
    if (!product) return;
    kaprukaRef = product;
  }

  const name = $('name').value.trim();
  const description = $('description').value.trim();
  if (!name) {
    $('hint').textContent = ' Enter a product name first.';
    return;
  }
  $('hint').textContent = '';
  $('go').disabled = true;
  if (es) { es.close(); es = null; }

  let curatedTotal = 0;
  let curatedDone = 0;
  let discoveredTotal = null;
  let discoveredDone = 0;
  let checkingDb = true;
  let dbFound = null;
  const partial = [];
  $('out').innerHTML = progressShell();

  const update = () => {
    if (checkingDb) {
      $('pbarFill').style.width = '8%';
      $('pcount').textContent = 'Checking our database…';
      return;
    }
    const known = curatedTotal + (discoveredTotal || 0);
    const done = curatedDone + discoveredDone;
    const pct = known ? Math.round((done / known) * 100) : 4;
    $('pbarFill').style.width = pct + '%';
    const more = discoveredTotal == null ? ' · finding more shops…' : '';
    const fromDb = dbFound ? ` · ${dbFound} already in our database` : '';
    $('pcount').textContent = `Checked ${done} of ${known} sites${more}${fromDb}`;
    $('plist').innerHTML = partial
      .map(
        (r) => `<div class="row"><span class="nm">${escapeHtml(r.site || r.domain || '—')}</span>
          ${statusText(r)} <span class="price">${r.price != null ? fmtPrice(r) : ''}</span></div>`,
      )
      .join('');
  };
  update();

  const qs = `name=${encodeURIComponent(name)}&description=${encodeURIComponent(description)}`;
  es = new EventSource('/api/match/stream?' + qs);

  es.addEventListener('progress', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'db-search-start') checkingDb = true;
    // The database half is done; the live web search is still running (both
    // always run now), so the progress bar switches to counting sites.
    else if (ev.type === 'db-results') { checkingDb = false; dbFound = ev.count; }
    else if (ev.type === 'start') { checkingDb = false; curatedTotal = ev.curatedTotal; }
    else if (ev.type === 'discoveredTotal') discoveredTotal = ev.count;
    else if (ev.type === 'site') {
      checkingDb = false;
      if (ev.phase === 'curated') curatedDone = ev.done;
      else discoveredDone = ev.done;
      if (ev.result) partial.push(ev.result);
    }
    update();
  });

  es.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    es.close();
    es = null; // also stops EventSource from auto-reconnecting
    render(data);
    $('go').disabled = false;
  });

  es.addEventListener('failed', (e) => {
    const msg = (() => { try { return JSON.parse(e.data).error; } catch { return 'request failed'; } })();
    es.close();
    es = null;
    $('out').innerHTML = `<p class="empty">Error: ${escapeHtml(msg)}</p>`;
    $('go').disabled = false;
  });

  // Connection-level error (only act if we didn't already finish).
  es.onerror = () => {
    if (!es) return;
    es.close();
    es = null;
    $('out').innerHTML = '<p class="empty">Connection lost. Please try again.</p>';
    $('go').disabled = false;
  };
}

$('go').addEventListener('click', run);
$('modeSearch').addEventListener('click', () => setSearchMode('search'));
$('modeUrl').addEventListener('click', () => setSearchMode('url'));
