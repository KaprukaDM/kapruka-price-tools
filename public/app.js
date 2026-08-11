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
  const cls = rate >= 75 ? 'b-hi' : rate >= 50 ? 'b-md' : 'b-lo';
  return `<span class="badge ${cls}">${rate ?? 0}%</span>`;
}

function buildTable(list) {
  const rows = list
    .map((r) => {
      const st = STATUS_LABEL[r.status] || STATUS_LABEL.error;
      const title = r.title
        ? `${r.url ? `<a href="${r.url}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a>` : escapeHtml(r.title)}`
        : (r.url ? `<a href="${r.url}" target="_blank" rel="noopener">view page</a>` : '—');
      const ctx = r.priceContext ? `<div class="ctx">${escapeHtml(r.priceContext)}</div>` : '';
      const note = r.note ? `<div class="ctx">${escapeHtml(r.note)}</div>` : '';
      // Show the model's reasoning when the match is weak, so you know WHY.
      const reason =
        (r.matchRate ?? 0) < 40 && r.reasoning
          ? `<div class="ctx reason">Why: ${escapeHtml(r.reasoning)}</div>`
          : '';
      return `<tr>
        <td><strong>${escapeHtml(r.site)}</strong><div class="ctx">${escapeHtml(r.domain || '')}</div></td>
        <td>${title}${reason}</td>
        <td><span class="price">${fmtPrice(r)}</span>${ctx}</td>
        <td>${badge(r.matchRate)}</td>
        <td class="${st.cls}">${st.text}${note}</td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr>
      <th>Site</th><th>Matched product</th><th>Price</th><th>Match rate</th><th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

// Set by run() when a Kapruka product URL was resolved, so render() can show
// the Kapruka price itself as a reference alongside the matched competitor
// prices. Cleared whenever a plain name/description search runs instead.
let kaprukaRef = null;

function kaprukaRefBlock() {
  if (!kaprukaRef) return '';
  const priceHtml = kaprukaRef.price != null ? fmtPrice(kaprukaRef) : 'price not found';
  return `<div class="card" style="margin-bottom:16px">
    <div class="ctx">Kapruka price</div>
    <div><strong><span class="price">${priceHtml}</span></strong>
      — <a href="${escapeHtml(kaprukaRef.url)}" target="_blank" rel="noopener">${escapeHtml(kaprukaRef.name || 'view on Kapruka')}</a>
    </div>
  </div>`;
}

// Browse mode: the typed query was too short/generic to identify one
// specific product (e.g. "iphone"), so the database returned every
// reasonably-matching product instead of one. Render each as its own
// mini-section with its own site-comparison table underneath.
function buildBrowseSections(products) {
  return products
    .map((p) => {
      const kaprukaLine = p.kaprukaPrice != null
        ? `<span class="price">Rs. ${Number(p.kaprukaPrice).toLocaleString('en-LK')}</span> on Kapruka`
        : 'price not listed on Kapruka';
      return `<div class="card" style="margin-bottom:14px">
        <h4 style="margin:0 0 4px">${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.name)}</a>` : escapeHtml(p.name)}</h4>
        <div class="ctx" style="margin-bottom:10px">${kaprukaLine}</div>
        ${p.results.length ? buildTable(p.results) : '<p class="empty" style="margin:0">No competitor matches cached for this product.</p>'}
      </div>`;
    })
    .join('');
}

function render(data) {
  const out = $('out');
  if (data.mode === 'browse') {
    const products = data.products || [];
    if (!products.length) {
      out.innerHTML = '<p class="empty">No results.</p>';
      return;
    }
    let html = `<h3 style="margin:24px 0 4px">Matched ${products.length} product${products.length === 1 ? '' : 's'} from our database</h3>
      <p class="note" style="margin-top:0">Your search matched more than one product — showing each separately.
        Type a more specific name (e.g. include the model/storage) for a single side-by-side comparison instead.</p>`;
    html += buildBrowseSections(products);
    out.innerHTML = html;
    return;
  }

  const dbResults = data.results || [];
  const discovered = data.discovered || [];
  const daraz = data.daraz && data.daraz.status && data.daraz.status !== 'error' && data.daraz.status !== 'no_result'
    ? data.daraz
    : null;
  if (dbResults.length === 0 && discovered.length === 0 && !daraz) {
    out.innerHTML = kaprukaRefBlock() + '<p class="empty">No results.</p>';
    return;
  }
  let html = kaprukaRefBlock();
  if (data.source === 'database') {
    html += '<h3 style="margin:24px 0 4px">Matched from our database</h3>' + buildTable(dbResults);
    html += `<p class="note" style="margin-top:14px">
      Prices come from our own scraped/matched catalogue, not a live fetch — refreshed periodically, not
      guaranteed to be this second's price. Click through to verify before acting on it.
    </p>`;
  } else {
    html += `<p class="note" style="margin-top:0">No confident match in our database yet —
      showing results from a live web search instead.</p>`;
    if (discovered.length) {
      html += '<h3 style="margin:24px 0 4px">Top Sri Lankan shops (from web search)</h3>' + buildTable(discovered);
    }
    html += `<p class="note" style="margin-top:14px">
      Flagged rows still link to the source page so you can verify manually.
      Web-search results exclude Daraz, Big Deals, ikman, Facebook and foreign sites (Daraz is checked
      separately below).
      Prices are pulled live; a non-LKR currency means the site geo-rendered for a different region.
    </p>`;
  }
  if (daraz) {
    html += '<h3 style="margin:24px 0 4px">Daraz.lk (live marketplace search)</h3>' + buildTable([daraz]);
    html += `<p class="note" style="margin-top:14px">
      A marketplace listing from a third-party seller, matched by name — not our own catalogue.
      Verify the seller and stock before buying.
    </p>`;
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
    $('pcount').textContent = `Checked ${done} of ${known} sites${more}`;
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
    else if (ev.type === 'db-search-empty') checkingDb = false;
    else if (ev.type === 'db-browse-found') checkingDb = false;
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
