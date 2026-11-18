// Reverse of partner-overpriced.js: products where the partner's own site is
// MORE expensive than Kapruka. Data comes from GET /api/underpriced, where
// `diff` is the positive rupee gap (partner − Kapruka) and `pct` is that gap
// relative to the Kapruka price.
const $ = (id) => document.getElementById(id);
let DATA = null;
let PAGE = 1;
const PAGE_SIZE = 50;

const HIDE_OFFLINE_KEY = 'partnerUnderpriced.hideOffline';
try {
  const stored = localStorage.getItem(HIDE_OFFLINE_KEY);
  $('hideOffline').checked = stored == null ? true : stored === '1';
} catch { /* private mode */ }

const COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'partner', label: 'Store' },
  { key: 'name', label: 'Product' },
  { key: 'nameSimilarity', label: 'Name Sim %', num: true },
  { key: 'kaprukaPrice', label: 'Kapruka', num: true },
  { key: 'partnerPrice', label: 'Partner site', num: true },
  { key: 'diff', label: 'Partner higher by', num: true },
  { key: 'pct', label: '%', num: true },
];
let SORT = { key: 'diff', dir: 'desc' };

const lkr = (v) => (v == null ? '—' : 'Rs.' + Number(v).toLocaleString('en-LK'));
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function link(url, text) {
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>` : escapeHtml(text);
}

const OFFLINE_REASONS = {
  unreachable: 'no response at all',
  server_error: 'server error',
  origin_missing: 'shop front page is gone',
  storefront_dead: 'home page loads but no product page opens',
  empty_catalogue: 'site lists no products',
};
const offlineReason = (s) => OFFLINE_REASONS[s] || 'site unreachable';

function sortRows(rows) {
  const col = COLUMNS.find((c) => c.key === SORT.key);
  const mul = SORT.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[SORT.key];
    const bv = b[SORT.key];
    if (col.num) {
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * mul;
    }
    const as = (av ?? '').toString().toLowerCase();
    const bs = (bv ?? '').toString().toLowerCase();
    return as < bs ? -mul : as > bs ? mul : 0;
  });
}

function theadHtml() {
  return '<tr>' + COLUMNS.map((c) => {
    const arrow = SORT.key === c.key ? (SORT.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}">${c.label}${arrow}</th>`;
  }).join('') + '</tr>';
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

function visibleItems() {
  return $('hideOffline').checked ? DATA.items.filter((i) => i.siteActive !== false) : DATA.items;
}

function statCards() {
  const card = (n, l, cls = '') => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const hide = $('hideOffline').checked;
  const items = visibleItems();
  const partners = hide ? DATA.partners.filter((p) => p.siteActive !== false) : DATA.partners;
  const stores = partners.filter((p) => p.flagged > 0).length;
  const total = items.reduce((s, i) => s + (i.diff ?? 0), 0);
  const excluded = DATA.count - items.length;
  $('cards').innerHTML =
    card(items.length, 'Underpriced products', 'good') +
    card(stores + ' / ' + partners.length, 'Stores affected') +
    card(lkr(Math.round(total)), 'Total price gap', 'good') +
    (excluded > 0 ? card(excluded, 'Hidden — offline stores') : '');
}

function offlineBanner() {
  const offline = DATA.partners.filter((p) => p.siteActive === false);
  if (!offline.length) { $('offlineBanner').innerHTML = ''; return; }
  const names = offline
    .map((p) => `${escapeHtml(p.partnerLabel || p.name)} <span class="ctx">(${escapeHtml(offlineReason(p.siteStatus))})</span>`)
    .join(', ');
  $('offlineBanner').innerHTML = `<div class="offline-banner">
    ⚠️ <strong>${offline.length} store${offline.length === 1 ? '' : 's'} appear offline</strong>
    — ${$('hideOffline').checked ? 'hidden from the list below' : 'shown below'}; their last known prices
    aren't something a customer can buy today: ${names}</div>`;
}

function countBy(items, key) {
  const map = new Map();
  for (const it of items) if (it[key]) map.set(it[key], (map.get(it[key]) || 0) + 1);
  return map;
}

function itemsForOptions(except) {
  const category = $('category').value;
  const store = $('store').value;
  const hide = $('hideOffline').checked;
  return DATA.items.filter((m) =>
    (except === 'category' || !category || m.category === category) &&
    (except === 'store' || !store || m.partnerId === store) &&
    (!hide || m.siteActive !== false));
}

function categoryOptions() {
  const sel = $('category');
  const current = sel.value;
  const counts = countBy(itemsForOptions('category'), 'category');
  const cats = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} · ${counts.get(c)}</option>`).join('');
  sel.value = counts.has(current) ? current : '';
}

function storeOptions() {
  const sel = $('store');
  const current = sel.value;
  const byPartner = new Map();
  for (const m of itemsForOptions('store')) {
    if (!m.partnerId) continue;
    const cur = byPartner.get(m.partnerId) || { name: m.partner, count: 0, offline: m.siteActive === false };
    cur.count++;
    byPartner.set(m.partnerId, cur);
  }
  const ids = [...byPartner.keys()].sort((a, b) => byPartner.get(b).count - byPartner.get(a).count);
  sel.innerHTML = '<option value="">All stores</option>' +
    ids.map((id) => {
      const p = byPartner.get(id);
      return `<option value="${escapeHtml(id)}">${p.offline ? '⚠️ ' : ''}${escapeHtml(p.name)} · ${p.count}</option>`;
    }).join('');
  sel.value = byPartner.has(current) ? current : '';
}

function pagerHtml(totalPages, totalItems) {
  if (totalPages <= 1) return '';
  return `<div class="pager">
      <button class="ghost" id="pgPrev" type="button" ${PAGE === 1 ? 'disabled' : ''}>‹ Prev</button>
      <span>Page ${PAGE} of ${totalPages} · ${totalItems} items</span>
      <button class="ghost" id="pgNext" type="button" ${PAGE === totalPages ? 'disabled' : ''}>Next ›</button>
    </div>`;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const store = $('store').value;
  const category = $('category').value;
  let rows = visibleItems().filter((m) =>
    (!category || m.category === category) &&
    (!store || m.partnerId === store) &&
    (!q || m.name.toLowerCase().includes(q)));

  if (!rows.length) {
    $('table').innerHTML = '<p class="empty">No underpriced products match your filter.</p>';
    return;
  }

  rows = sortRows(rows);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  PAGE = Math.min(PAGE, totalPages);
  const body = rows.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE).map((m) => {
    const pct = m.pct == null ? '' : `+${m.pct.toFixed(1)}%`;
    const offline = m.siteActive === false
      ? ` <span class="badge badge-offline" title="Offline on last check: ${escapeHtml(offlineReason(m.siteStatus))}">⚠️ offline</span>` : '';
    return `<tr class="under">
      <td>${escapeHtml(m.category)}</td>
      <td><span class="store-pill">${escapeHtml(m.partner)}</span>${offline}${m.partnerLabel ? `<div class="ctx">${escapeHtml(m.partnerLabel)}</div>` : ''}</td>
      <td class="col-product">
        <div class="prod-name">${link(m.kaprukaUrl, m.name)}</div>
        <div class="prod-name prod-partner">${link(m.partnerUrl, m.partnerProductName || m.partnerLabel || '—')}</div>
      </td>
      <td class="num">${m.nameSimilarity != null ? m.nameSimilarity + '%' : '—'}</td>
      <td class="num price">${lkr(m.kaprukaPrice)}</td>
      <td class="num">${lkr(m.partnerPrice)}</td>
      <td class="num gap-amt">+${lkr(m.diff)}</td>
      <td class="num gap-amt">${pct}</td>
    </tr>`;
  }).join('');

  $('table').innerHTML = `<div class="table-wrap"><table><thead>${theadHtml()}</thead>
    <tbody>${body}</tbody></table></div>${pagerHtml(totalPages, rows.length)}`;
  if (totalPages > 1) {
    const go = (p) => { PAGE = p; render(); $('table').scrollIntoView({ block: 'start', behavior: 'smooth' }); };
    $('pgPrev')?.addEventListener('click', () => go(Math.max(1, PAGE - 1)));
    $('pgNext')?.addEventListener('click', () => go(Math.min(totalPages, PAGE + 1)));
  }
  wireSort();
}

function paint() {
  statCards();
  offlineBanner();
  categoryOptions();
  storeOptions();
  render();
  $('footmeta').textContent = DATA.lastUpdated
    ? `Latest stored comparison for each store · last updated ${new Date(DATA.lastUpdated).toLocaleString()} · "Partner higher by" = partner-site price − Kapruka price; % is relative to the Kapruka price.`
    : 'No comparison data stored yet.';
  $('status').style.display = 'none';
  $('app').style.display = '';
}

async function load() {
  try {
    const res = await fetch('/api/underpriced');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    DATA = data;
    paint();
  } catch (err) {
    $('status').innerHTML = `Error: ${escapeHtml(err.message)} <button class="ghost" onclick="location.reload()">Retry</button>`;
  }
}

function exportCsv() {
  const params = new URLSearchParams();
  if ($('store').value) params.set('partner', $('store').value);
  if ($('category').value) params.set('category', $('category').value);
  const qs = params.toString();
  window.location.href = '/api/export/underpriced.csv' + (qs ? '?' + qs : '');
}

$('search').addEventListener('input', () => { PAGE = 1; render(); });
$('category').addEventListener('change', () => { PAGE = 1; storeOptions(); categoryOptions(); render(); });
$('store').addEventListener('change', () => { PAGE = 1; categoryOptions(); storeOptions(); render(); });
$('hideOffline').addEventListener('change', () => {
  PAGE = 1;
  try { localStorage.setItem(HIDE_OFFLINE_KEY, $('hideOffline').checked ? '1' : '0'); } catch { /* private mode */ }
  statCards(); offlineBanner(); categoryOptions(); storeOptions(); render();
});
$('exportCsv').addEventListener('click', exportCsv);

load();
