const $ = (id) => document.getElementById(id);
let DATA = null;
let TAB = 'matched';
let PARTNER_LABEL = 'partner site';

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

  if (TAB === 'matched') {
    let rows = DATA.matched.filter((m) => match(m.name + ' ' + m.partnerName));
    if ($('overOnly').checked) rows = rows.filter((m) => m.verdict === 'kapruka_higher');
    shown = rows.length;
    html = `<table><thead><tr>
        <th>Product</th><th class="num">Kapruka</th><th class="num">${escapeHtml(PARTNER_LABEL)}</th>
        <th class="num">Diff</th><th class="num">%</th><th>Verdict</th></tr></thead>
      <tbody>${matchedRows(rows)}</tbody></table>`;
  } else if (TAB === 'onlyKapruka') {
    const rows = DATA.onlyKapruka.filter((r) => match(r.name));
    shown = rows.length;
    html = `<table><thead><tr><th>Product (listed on Kapruka, not found on ${escapeHtml(PARTNER_LABEL)})</th>
        <th class="num">Kapruka price</th></tr></thead><tbody>${listRows(rows, false)}</tbody></table>`;
  } else {
    const rows = DATA.onlyPartner.filter((r) => match(r.name));
    shown = rows.length;
    html = `<table><thead><tr><th>Product (on ${escapeHtml(PARTNER_LABEL)}, not listed on Kapruka)</th>
        <th class="num">Partner price</th></tr></thead><tbody>${listRows(rows, true)}</tbody></table>`;
  }
  $('table').innerHTML = shown ? html : '<p class="empty">No products match your filter.</p>';
}

function footmeta() {
  const at = new Date(DATA.generatedAt);
  $('footmeta').textContent =
    `Catalogues: ${DATA.catalogCounts.kapruka} on Kapruka, ${DATA.catalogCounts.partner} on ${PARTNER_LABEL} ` +
    `(${DATA.partner.platform}) · matched by model code (high) or name similarity (review) · ` +
    `generated ${at.toLocaleString()}` + (DATA.cached ? ' (cached)' : ' · saved to database');
}

async function load(force) {
  const partnerId = $('partner').value;
  $('status').style.display = '';
  $('app').style.display = 'none';
  $('status').innerHTML = '<span class="spin"></span>' +
    (force ? 'Refreshing live prices from both sites… (~10s)' : 'Fetching both catalogues and matching products… (~10s)');
  try {
    const url = '/api/compare?partner=' + encodeURIComponent(partnerId) + (force ? '&refresh=1' : '');
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    DATA = data;
    PARTNER_LABEL = data.partner.partnerLabel || data.partner.name;
    $('title').textContent = `${data.partner.name} — Kapruka vs. ${PARTNER_LABEL}`;
    const kLink = data.partner.kaprukaLink || '';
    $('subtitle').innerHTML =
      `Our listing <a href="${escapeHtml(kLink)}" target="_blank" rel="noopener">${escapeHtml(kLink.replace(/^https?:\/\//, ''))}</a> ` +
      `reconciled against <a href="${escapeHtml(data.partner.partnerSite)}" target="_blank" rel="noopener">${escapeHtml(PARTNER_LABEL)}</a>.`;
    statCards(data.summary, data.catalogCounts, data.partner.name);
    buildTabs(data.summary, data.partner.name);
    render();
    footmeta();
    $('status').style.display = 'none';
    $('app').style.display = '';
  } catch (err) {
    $('status').innerHTML = `Error: ${escapeHtml(err.message)} <button class="ghost" onclick="location.reload()">Retry</button>`;
  }
}

async function loadPartners(selectId) {
  const res = await fetch('/api/partners');
  const partners = await res.json();
  $('partner').innerHTML = partners
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join('');
  if (selectId) $('partner').value = selectId;
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
    load(false); // first run for this partner -> computes + stores to DB
  } catch (err) {
    $('addHint').textContent = ' ' + err.message;
  } finally {
    $('addSubmit').disabled = false;
    $('addSubmit').textContent = prev;
  }
}

$('search').addEventListener('input', render);
$('overOnly').addEventListener('change', render);
$('refresh').addEventListener('click', () => load(true));
$('partner').addEventListener('change', () => load(false));
$('toggleAdd').addEventListener('click', () => {
  const c = $('addCard');
  c.style.display = c.style.display === 'none' ? '' : 'none';
});
$('addSubmit').addEventListener('click', addStore);

(async function init() {
  await loadPartners();
  load(false);
})();
