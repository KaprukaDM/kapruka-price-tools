const $ = (id) => document.getElementById(id);
let DATA = null;
let PAGE = 1;
const PAGE_SIZE = 50;

const COLUMNS = [
  { key: 'partner', label: 'Store' },
  { key: 'name', label: 'Product' },
  { key: 'kaprukaPrice', label: 'Kapruka', num: true },
  { key: 'partnerPrice', label: 'Partner site', num: true },
  { key: 'diff', label: 'Overcharge', num: true },
  { key: 'pct', label: '%', num: true },
];
let SORT = { key: 'diff', dir: 'desc' };

function sortRows(rows) {
  const col = COLUMNS.find((c) => c.key === SORT.key);
  const mul = SORT.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[SORT.key];
    const bv = b[SORT.key];
    if (col.num) {
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last regardless of direction
      if (bv == null) return -1;
      return (av - bv) * mul;
    }
    const as = (av ?? '').toString().toLowerCase();
    const bs = (bv ?? '').toString().toLowerCase();
    return as < bs ? -mul : as > bs ? mul : 0;
  });
}

function theadHtml() {
  const cells = COLUMNS.map((c) => {
    const active = SORT.key === c.key;
    const arrow = active ? (SORT.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}">${c.label}${arrow}</th>`;
  }).join('');
  return `<tr>${cells}</tr>`;
}

function wireSort() {
  $('table').querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const col = COLUMNS.find((c) => c.key === key);
      if (SORT.key === key) SORT.dir = SORT.dir === 'asc' ? 'desc' : 'asc';
      else SORT = { key, dir: col.num ? 'desc' : 'asc' };
      PAGE = 1;
      render();
    });
  });
}

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

function statCards(d) {
  const card = (n, l, cls = '') => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const stores = d.partners.filter((p) => p.overpriced > 0).length;
  $('cards').innerHTML =
    card(d.count, 'Overpriced products', 'bad') +
    card(stores + ' / ' + d.partners.length, 'Stores affected') +
    card(lkr(Math.round(d.totalOvercharge)), 'Total overcharge', 'bad');
}

function storeOptions(d) {
  const sel = $('store');
  const current = sel.value;
  sel.innerHTML = '<option value="">All stores</option>' +
    d.partners
      .filter((p) => p.overpriced > 0)
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${p.overpriced}</option>`)
      .join('');
  sel.value = current;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const store = $('store').value;
  let rows = DATA.items.filter(
    (m) => (!store || m.partnerId === store) && (!q || m.name.toLowerCase().includes(q)),
  );

  if (!rows.length) {
    $('table').innerHTML = '<p class="empty">No overpriced products match your filter. 🎉</p>';
    return;
  }

  rows = sortRows(rows);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  PAGE = Math.min(PAGE, totalPages);
  const pageRows = rows.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE);

  const body = pageRows
    .map((m) => {
      const pct = m.pct == null ? '' : `+${m.pct.toFixed(1)}%`;
      const conf = m.confidence === 'high'
        ? '<span class="badge b-hi">high</span>'
        : '<span class="badge b-md">review</span>';
      return `<tr class="over">
        <td><span class="store-pill">${escapeHtml(m.partner)}</span></td>
        <td>${link(m.kaprukaUrl, m.name)}
          <div class="ctx">matched: ${link(m.partnerUrl, m.partnerLabel)} · ${conf} · name sim ${m.nameSimilarity ?? '—'}%</div></td>
        <td class="num price">${lkr(m.kaprukaPrice)}</td>
        <td class="num">${lkr(m.partnerPrice)}</td>
        <td class="num over-amt">+${lkr(m.diff)}</td>
        <td class="num over-amt">${pct}</td>
      </tr>`;
    })
    .join('');

  $('table').innerHTML = `<div class="table-wrap"><table><thead>${theadHtml()}</thead>
    <tbody>${body}</tbody></table></div>${pagerHtml(totalPages, rows.length)}`;
  wirePager(totalPages);
  wireSort();
}

function footmeta() {
  if (!DATA.lastUpdated) {
    $('footmeta').textContent = 'No comparison data stored yet — the daily refresh will populate this shortly.';
    return;
  }
  const at = new Date(DATA.lastUpdated);
  $('footmeta').textContent =
    `Showing the latest stored comparison for each store · last updated ${at.toLocaleString()} · ` +
    'refreshes automatically once a day. "Overcharge" = Kapruka price − partner-site price.';
}

function paint() {
  statCards(DATA);
  storeOptions(DATA);
  render();
  footmeta();
  $('status').style.display = 'none';
  $('app').style.display = '';
}

async function load() {
  try {
    const res = await fetch('/api/overpriced');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    DATA = data;
    paint();
  } catch (err) {
    $('status').innerHTML = `Error: ${escapeHtml(err.message)} <button class="ghost" onclick="location.reload()">Retry</button>`;
  }
}

async function refreshNow() {
  const btn = $('refresh');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>Refreshing all stores… (~1–2 min)';
  try {
    const res = await fetch('/api/overpriced/refresh', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'refresh failed');
    DATA = data;
    paint();
  } catch (err) {
    alert('Refresh failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

$('search').addEventListener('input', () => { PAGE = 1; render(); });
$('store').addEventListener('change', () => { PAGE = 1; render(); });
$('refresh').addEventListener('click', refreshNow);

load();
