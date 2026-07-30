const $ = (id) => document.getElementById(id);
let DATA = null;
let TAB = 'matched';
let PARTNER_LABEL = 'partner site';
let PAGE = 1;
const PAGE_SIZE = 50;

function pagerHtml(totalPages, totalItems) {
  if (totalPages <= 1) return '';
  return `<div class="pager">
      <button class="ghost" id="pgPrev" type="button" ${PAGE === 1 ? 'disabled' : ''}>‹ Prev</button>
      <span>Page ${PAGE} of ${totalPages} · ${totalItems} items</span>
      <button class="ghost" id="pgNext" type="button" ${PAGE === totalPages ? 'disabled' : ''}>Next ›</button>
    </div>`;
}
function wirePager(totalPages) {
  if (totalPages <= 1) return;
  $('pgPrev')?.addEventListener('click', () => { PAGE = Math.max(1, PAGE - 1); render(); $('table').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  $('pgNext')?.addEventListener('click', () => { PAGE = Math.min(totalPages, PAGE + 1); render(); $('table').scrollIntoView({ block: 'start', behavior: 'smooth' }); });
}

const lkr = (v) => (v == null ? '—' : 'Rs.' + Number(v).toLocaleString('en-LK'));
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
function link(url, text) {
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>` : escapeHtml(text);
}

const VERDICT = {
  kapruka_higher: { label: 'Kapruka overpriced', cls: 'v-over', row: 'over' },
  kapruka_lower: { label: 'Kapruka cheaper', cls: 'v-under', row: 'under' },
  same: { label: 'Same price', cls: 'v-same', row: 'same' },
  price_missing: { label: 'Price missing', cls: 'v-same', row: '' },
};

function statCards(s, c, partnerName) {
  const card = (n, l, cls = '') => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  $('cards').innerHTML =
    card(s.matched, 'Matched (both)') +
    card(s.kaprukaHigher, 'Kapruka overpriced', 'bad') +
    card(s.kaprukaLower, 'Kapruka cheaper', 'good') +
    card(s.same, 'Same price') +
    card(s.onlyKapruka, 'Only on Kapruka') +
    card(s.onlyPartner, 'Only on ' + escapeHtml(partnerName)) +
    card(c.kapruka + ' / ' + c.partner, 'Catalog K / Partner');
}

function buildTabs(s, partnerName) {
  const defs = [
    ['matched', `Matched · ${s.matched}`],
    ['onlyKapruka', `Only on Kapruka · ${s.onlyKapruka}`],
    ['onlyPartner', `Only on ${escapeHtml(partnerName)} · ${s.onlyPartner}`],
  ];
  $('tabs').innerHTML = defs
    .map(([k, label]) => `<div class="tab ${k === TAB ? 'active' : ''}" data-tab="${k}">${label}</div>`)
    .join('');
  $('tabs').querySelectorAll('.tab').forEach((el) =>
    el.addEventListener('click', () => {
      TAB = el.dataset.tab;
      PAGE = 1;
      buildTabs(s, partnerName);
      render();
    }),
  );
  $('overOnlyWrap').style.display = TAB === 'matched' ? '' : 'none';
}

function matchedRows(rows) {
  const order = { kapruka_higher: 0, price_missing: 1, kapruka_lower: 2, same: 3 };
  return [...rows]
    .sort((a, b) => (order[a.verdict] - order[b.verdict]) || (Math.abs(b.diff || 0) - Math.abs(a.diff || 0)))
    .map((m) => {
      const v = VERDICT[m.verdict] || VERDICT.price_missing;
      const pct = m.pct == null ? '' : `${m.pct > 0 ? '+' : ''}${m.pct.toFixed(1)}%`;
      const conf = m.confidence === 'high'
        ? '<span class="badge b-hi">high</span>'
        : '<span class="badge b-md">review</span>';
      return `<tr class="${v.row}">
        <td>${link(m.kaprukaUrl, m.name)}
          <div class="ctx">matched: ${link(m.partnerUrl, m.partnerName)} · ${conf} · name sim ${m.nameSimilarity}%</div></td>
        <td class="num price">${lkr(m.kaprukaPrice)}</td>
        <td class="num">${lkr(m.partnerPrice)}</td>
        <td class="num">${m.diff == null ? '' : (m.diff > 0 ? '+' : '') + lkr(m.diff)}</td>
        <td class="num">${pct}</td>
        <td class="${v.cls}">${v.label}</td>
      </tr>`;
    })
    .join('');
}

function listRows(rows, withSku) {
  return rows
    .map(
      (r) => `<tr>
        <td>${link(r.url, r.name)}${withSku && r.sku ? `<div class="ctx">SKU: ${escapeHtml(r.sku)}</div>` : ''}</td>
        <td class="num price">${lkr(r.price)}</td>
      </tr>`,
    )
    .join('');
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const match = (name) => !q || name.toLowerCase().includes(q);
  let html = '';
  let shown = 0;
  let totalPages = 1;

  if (TAB === 'matched') {
    let rows = DATA.matched.filter((m) => match(m.name + ' ' + m.partnerName));
    if ($('overOnly').checked) rows = rows.filter((m) => m.verdict === 'kapruka_higher');
    shown = rows.length;
    totalPages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
    PAGE = Math.min(PAGE, totalPages);
    const pageRows = rows.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE);
    html = `<div class="table-wrap"><table><thead><tr>
        <th>Product</th><th class="num">Kapruka</th><th class="num">${escapeHtml(PARTNER_LABEL)}</th>
        <th class="num">Diff</th><th class="num">%</th><th>Verdict</th></tr></thead>
      <tbody>${matchedRows(pageRows)}</tbody></table></div>`;
  } else if (TAB === 'onlyKapruka') {
    const rows = DATA.onlyKapruka.filter((r) => match(r.name));
    shown = rows.length;
    totalPages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
    PAGE = Math.min(PAGE, totalPages);
    const pageRows = rows.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE);
    html = `<div class="table-wrap"><table><thead><tr><th>Product (listed on Kapruka, not found on ${escapeHtml(PARTNER_LABEL)})</th>
        <th class="num">Kapruka price</th></tr></thead><tbody>${listRows(pageRows, false)}</tbody></table></div>`;
  } else {
    const rows = DATA.onlyPartner.filter((r) => match(r.name));
    shown = rows.length;
    totalPages = Math.max(1, Math.ceil(shown / PAGE_SIZE));
    PAGE = Math.min(PAGE, totalPages);
    const pageRows = rows.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE);
    html = `<div class="table-wrap"><table><thead><tr><th>Product (on ${escapeHtml(PARTNER_LABEL)}, not listed on Kapruka)</th>
        <th class="num">Partner price</th></tr></thead><tbody>${listRows(pageRows, true)}</tbody></table></div>`;
  }
  $('table').innerHTML = shown ? html + pagerHtml(totalPages, shown) : '<p class="empty">No products match your filter.</p>';
  wirePager(totalPages);
}

function footmeta() {
  const at = new Date(DATA.generatedAt);
  $('footmeta').textContent =
    `Catalogues: ${DATA.catalogCounts.kapruka} on Kapruka, ${DATA.catalogCounts.partner} on ${PARTNER_LABEL} ` +
    `(${DATA.partner.platform}) · matched by model code (high) or name similarity (review) · ` +
    `Last updated: ${at.toLocaleString()}`;
}

function scrapingStatusHtml(lastLine, elapsedSec) {
  const elapsed = elapsedSec != null ? ` · ${elapsedSec}s elapsed` : '';
  return (
    '<div class="spin"></div>' +
    `<div>${escapeHtml(lastLine || 'Scraping…')}${elapsed}</div>` +
    '<div class="progress-bar"><div class="progress-bar-fill"></div></div>'
  );
}

let pollTimer = null;

// Renders whatever /api/compare currently has for this partner. If there's
// no stored data yet ("pending"), this shows either live scrape progress (if
// this server instance is the one actively scraping it — see SCRAPE_ON_ADD
// in server.js) or a calm "check back later" message (if it's waiting on the
// scheduled job instead, which runs as a separate process this page can't
// see progress from) — and keeps polling every few seconds either way until
// real data shows up.
async function attemptLoad(partnerId, startedAt) {
  try {
    const res = await fetch('/api/compare?partner=' + encodeURIComponent(partnerId));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');

    if (data.pending) {
      const pRes = await fetch('/api/compare/progress?partner=' + encodeURIComponent(partnerId));
      const p = await pRes.json();
      if (p.running) {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const lastLine = p.lines && p.lines.length ? p.lines[p.lines.length - 1].trim() : null;
        $('status').innerHTML = scrapingStatusHtml(lastLine, elapsedSec);
      } else {
        $('status').innerHTML = `<div>${escapeHtml(data.message || 'Not ready yet — check back shortly.')}</div>`;
      }
      if (!pollTimer) pollTimer = setInterval(() => attemptLoad(partnerId, startedAt), 4000);
      return;
    }

    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    DATA = data;
    PARTNER_LABEL = data.partner.partnerLabel || data.partner.name;
    $('title').textContent = `${data.partner.name} — Kapruka vs. ${PARTNER_LABEL}`;
    const kLink = data.partner.kaprukaLink || '';
    $('subtitle').innerHTML =
      `Our listing <a href="${escapeHtml(kLink)}" target="_blank" rel="noopener">${escapeHtml(kLink.replace(/^https?:\/\//, ''))}</a> ` +
      `reconciled against <a href="${escapeHtml(data.partner.partnerSite)}" target="_blank" rel="noopener">${escapeHtml(PARTNER_LABEL)}</a>.`;
    // Scope the CSV export to the partner currently in view.
    $('exportCsv').href = '/api/export/comparison.csv?partner=' + encodeURIComponent(partnerId);
    statCards(data.summary, data.catalogCounts, data.partner.name);
    buildTabs(data.summary, data.partner.name);
    render();
    footmeta();
    $('status').style.display = 'none';
    $('app').style.display = '';
    $('refreshHint').textContent = '';
  } catch (err) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    $('status').innerHTML = `Error: ${escapeHtml(err.message)} <button class="ghost" onclick="location.reload()">Retry</button>`;
  }
}

async function load() {
  const partnerId = $('partner').value;
  PAGE = 1;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  $('status').style.display = '';
  $('app').style.display = 'none';
  $('status').innerHTML = scrapingStatusHtml('Loading…', null);
  await attemptLoad(partnerId, Date.now());
}

// The Refresh button doesn't scrape anything itself, from anywhere — it just
// records a request. The scheduled job (running from a confirmed-good
// Kapruka-geo host) picks it up on its next pass and does the actual
// rescrape. Safe to click from any instance, including the VPS.
async function requestRefresh() {
  const partnerId = $('partner').value;
  if (!partnerId) return;
  $('refresh').disabled = true;
  $('refreshHint').textContent = '';
  try {
    const res = await fetch('/api/compare/refresh-request?partner=' + encodeURIComponent(partnerId), {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not request refresh');
    $('refreshHint').textContent = 'Refresh requested — updates within ~15 min.';
  } catch (err) {
    $('refreshHint').textContent = 'Error: ' + err.message;
  } finally {
    $('refresh').disabled = false;
  }
}

let PARTNERS = [];

async function loadPartners(selectId) {
  const res = await fetch('/api/partners');
  const partners = await res.json();
  PARTNERS = partners;
  $('partner').innerHTML = partners
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join('');
  $('partner').value = selectId || (partners[0] && partners[0].id) || '';
  syncPartnerSearchLabel();
}

function syncPartnerSearchLabel() {
  const p = PARTNERS.find((p) => p.id === $('partner').value);
  $('partnerSearch').value = p ? p.name : '';
}

function renderPartnerMenu(query) {
  const q = query.trim().toLowerCase();
  const items = PARTNERS.filter((p) => !q || p.name.toLowerCase().includes(q));
  $('partnerMenu').innerHTML = items.length
    ? items.map((p) => `<div class="combo-item" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</div>`).join('')
    : '<div class="combo-empty">No matching partners</div>';
  $('partnerMenu').hidden = false;
}

function selectPartner(id) {
  $('partner').value = id;
  syncPartnerSearchLabel();
  $('partnerMenu').hidden = true;
  $('partner').dispatchEvent(new Event('change'));
}

async function addStore() {
  const name = $('addName').value.trim();
  const partnerSite = $('addSite').value.trim();
  const kaprukaUrl = $('addKapruka').value.trim();
  if (!name || !partnerSite || !kaprukaUrl) {
    $('addHint').textContent = ' Fill in all three fields.';
    return;
  }
  $('addHint').textContent = '';
  $('addSubmit').disabled = true;
  const prev = $('addSubmit').textContent;
  $('addSubmit').innerHTML = '<span class="spin"></span>Validating…';
  try {
    const res = await fetch('/api/partners', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, partnerSite, kaprukaUrl }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add store');
    // Success: refresh the dropdown, select the new partner, collapse, compare.
    await loadPartners(data.id);
    $('addCard').style.display = 'none';
    $('addName').value = $('addSite').value = $('addKapruka').value = '';
    load(); // first run for this partner -> computes + stores to DB
  } catch (err) {
    $('addHint').textContent = ' ' + err.message;
  } finally {
    $('addSubmit').disabled = false;
    $('addSubmit').textContent = prev;
  }
}

$('search').addEventListener('input', () => { PAGE = 1; render(); });
$('overOnly').addEventListener('change', () => { PAGE = 1; render(); });
$('partner').addEventListener('change', () => load());
// Clicking a pre-filled box should offer the full list to pick a different
// partner from, not just filter down to the one already selected.
$('partnerSearch').addEventListener('focus', () => { $('partnerSearch').select(); renderPartnerMenu(''); });
$('partnerSearch').addEventListener('input', () => renderPartnerMenu($('partnerSearch').value));
$('partnerSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('partnerMenu').hidden = true; syncPartnerSearchLabel(); $('partnerSearch').blur(); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    const first = $('partnerMenu').querySelector('.combo-item');
    if (first) selectPartner(first.dataset.id);
  }
});
$('partnerMenu').addEventListener('mousedown', (e) => {
  const item = e.target.closest('.combo-item');
  if (item) selectPartner(item.dataset.id);
});
document.addEventListener('click', (e) => {
  if (!$('partnerCombo').contains(e.target)) { $('partnerMenu').hidden = true; syncPartnerSearchLabel(); }
});
$('refresh').addEventListener('click', requestRefresh);
$('toggleAdd').addEventListener('click', () => {
  const c = $('addCard');
  c.style.display = c.style.display === 'none' ? '' : 'none';
});
$('addSubmit').addEventListener('click', addStore);

(async function init() {
  await loadPartners();
  load();
})();
