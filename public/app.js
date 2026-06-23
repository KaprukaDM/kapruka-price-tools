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

// When a Kapruka source price is set, show how each store compares to it.
function deltaVsSource(r, sourcePrice) {
  if (sourcePrice == null || r.price == null) return '';
  if (r.currency && r.currency.toUpperCase() !== 'LKR') return '';
  const diff = Number(r.price) - sourcePrice;
  const pct = Math.round((Math.abs(diff) / sourcePrice) * 100);
  if (diff === 0) return `<div class="ctx delta-eq">same as Kapruka</div>`;
  const abs = Math.abs(diff).toLocaleString('en-LK');
  return diff < 0
    ? `<div class="ctx delta-lo">▼ Rs.${abs} cheaper (${pct}%)</div>`
    : `<div class="ctx delta-hi">▲ Rs.${abs} dearer (${pct}%)</div>`;
}

function buildTable(list, sourcePrice = null) {
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
        <td><span class="price">${fmtPrice(r)}</span>${ctx}${deltaVsSource(r, sourcePrice)}</td>
        <td>${badge(r.matchRate)}</td>
        <td class="${st.cls}">${st.text}${note}</td>
      </tr>`;
    })
    .join('');
  return `<table><thead><tr>
      <th>Site</th><th>Matched product</th><th>Price</th><th>Match rate</th><th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

// Reference card for the Kapruka source product (URL mode only).
function sourceCard(src) {
  if (!src) return '';
  const price =
    src.price != null ? `Rs.${Number(src.price).toLocaleString('en-LK')}` : '—';
  const img = src.image
    ? `<img src="${escapeHtml(src.image)}" alt="" onerror="this.style.display='none'" />`
    : '';
  const link = src.url
    ? `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${escapeHtml(src.name || 'Kapruka product')}</a>`
    : escapeHtml(src.name || 'Kapruka product');
  return `<div class="source-card">${img}
    <div class="s-meta"><div class="s-label">Source · Kapruka</div><div class="s-name">${link}</div></div>
    <div class="s-price">${price}</div>
  </div>`;
}

function render(data) {
  const out = $('out');
  const curated = data.results || [];
  const discovered = data.discovered || [];
  const src = kaprukaSource;
  const srcPrice = src ? src.price ?? null : null;
  if (curated.length === 0 && discovered.length === 0) {
    out.innerHTML = sourceCard(src) + '<p class="empty">No results.</p>';
    return;
  }
  let html = sourceCard(src);
  if (curated.length) {
    html += '<h3 style="margin:24px 0 4px">Curated sites</h3>' + buildTable(curated, srcPrice);
  }
  if (discovered.length) {
    html +=
      '<h3 style="margin:28px 0 4px">Top Sri Lankan shops (from web search)</h3>' +
      buildTable(discovered, srcPrice);
  }
  html += `<p class="note" style="margin-top:14px">
    Flagged rows still link to the source page so you can verify manually.
    Web-search results exclude Daraz, Big Deals, ikman, Facebook and foreign sites.
    Prices are pulled live; a non-LKR currency means the site geo-rendered for a different region.
  </p>`;
  out.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

async function loadCategories() {
  const res = await fetch('/api/categories');
  const cats = await res.json();
  const sel = $('category');
  sel.innerHTML = Object.keys(cats)
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} (${cats[c].length} sites)</option>`)
    .join('');
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
let mode = 'manual'; // 'manual' | 'kapruka'
let kaprukaSource = null; // resolved Kapruka product when in URL mode

function setMode(m) {
  mode = m;
  document.querySelectorAll('.mode-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === m),
  );
  const url = m === 'kapruka';
  $('kaprukaFields').hidden = !url;
  // In URL mode the name/description come from the Kapruka page, so hide those.
  $('nameField').hidden = url;
  $('descField').hidden = url;
  $('go').textContent = url ? 'Fetch from Kapruka & match' : 'Match prices';
  $('hint').textContent = '';
}

// URL mode: resolve the Kapruka product first, fill the query fields, then match.
async function runFromUrl() {
  const url = $('kurl').value.trim();
  if (!url) {
    $('hint').textContent = ' Paste a Kapruka product URL first.';
    return;
  }
  $('hint').textContent = '';
  $('go').disabled = true;
  $('out').innerHTML = '<p class="empty"><span class="spin"></span>Reading the Kapruka product…</p>';
  try {
    const res = await fetch('/api/kapruka/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      $('out').innerHTML = `<p class="empty">Error: ${escapeHtml(data.error || 'could not read product')}</p>`;
      $('go').disabled = false;
      return;
    }
    kaprukaSource = {
      name: data.name,
      price: data.price,
      currency: data.currency,
      url: data.url,
      image: data.image,
    };
    // Feed the resolved values into the shared query fields and run the match.
    $('name').value = data.name || '';
    $('description').value = data.description || '';
    if (data.suggestedCategory) $('category').value = data.suggestedCategory;
    run();
  } catch (err) {
    $('out').innerHTML = `<p class="empty">Error: ${escapeHtml(err.message)}</p>`;
    $('go').disabled = false;
  }
}

// Stream the match over Server-Sent Events so we can show live progress
// (which/how many sites are done) instead of a silent ~60s wait.
function run() {
  const category = $('category').value;
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
  const partial = [];
  $('out').innerHTML = progressShell();

  const update = () => {
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

  const qs = `category=${encodeURIComponent(category)}&name=${encodeURIComponent(name)}&description=${encodeURIComponent(description)}`;
  es = new EventSource('/api/match/stream?' + qs);

  es.addEventListener('progress', (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'start') curatedTotal = ev.curatedTotal;
    else if (ev.type === 'discoveredTotal') discoveredTotal = ev.count;
    else if (ev.type === 'site') {
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

document.querySelectorAll('.mode-btn').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode)),
);

$('go').addEventListener('click', () => {
  if (mode === 'kapruka') {
    runFromUrl();
  } else {
    kaprukaSource = null; // manual mode has no reference price
    run();
  }
});
loadCategories();
