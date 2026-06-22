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

function render(data) {
  const out = $('out');
  const curated = data.results || [];
  const discovered = data.discovered || [];
  if (curated.length === 0 && discovered.length === 0) {
    out.innerHTML = '<p class="empty">No results.</p>';
    return;
  }
  let html = '';
  if (curated.length) {
    html += '<h3 style="margin:24px 0 4px">Curated sites</h3>' + buildTable(curated);
  }
  if (discovered.length) {
    html +=
      '<h3 style="margin:28px 0 4px">Top Sri Lankan shops (from web search)</h3>' +
      buildTable(discovered);
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

async function run() {
  const category = $('category').value;
  const name = $('name').value.trim();
  const description = $('description').value.trim();
  if (!name) {
    $('hint').textContent = ' Enter a product name first.';
    return;
  }
  $('hint').textContent = '';
  $('go').disabled = true;
  $('out').innerHTML = '<p class="empty"><span class="spin"></span>Searching, scraping and scoring across sites…</p>';
  try {
    const res = await fetch('/api/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, name, description }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    render(data);
  } catch (err) {
    $('out').innerHTML = `<p class="empty">Error: ${escapeHtml(err.message)}</p>`;
  } finally {
    $('go').disabled = false;
  }
}

$('go').addEventListener('click', run);
loadCategories();
