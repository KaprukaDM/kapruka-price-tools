const $ = (id) => document.getElementById(id);
let DATA = null;

const COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'partner', label: 'Store' },
  { key: 'name', label: 'Product' },
  { key: 'kaprukaPrice', label: 'Kapruka', num: true },
  { key: 'partnerPrice', label: 'Partner site', num: true },
];
const PAGE_SIZE = 50;

// Two directions sharing the page's category/store/search filters and one
// table — the toggle switch picks which is currently rendered, each keeping
// its own sort/page state across switches.
const PANELS = {
  partner: { rowClass: 'stock-partner', sort: { key: 'name', dir: 'asc' }, page: 1, rows: [] },
  kapruka: { rowClass: 'stock-kapruka', sort: { key: 'name', dir: 'asc' }, page: 1, rows: [] },
};
let ACTIVE_DIR = 'partner';

function sortRows(rows, sort) {
  const col = COLUMNS.find((c) => c.key === sort.key);
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
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

function theadHtml(sort) {
  const cells = COLUMNS.map((c) => {
    const active = sort.key === c.key;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}">${c.label}${arrow}</th>`;
  }).join('');
  return `<tr>${cells}</tr>`;
}

function pagerHtml(panel, totalPages, totalItems) {
  if (totalPages <= 1) return '';
  return `<div class="pager">
      <button class="ghost" data-pg="prev" type="button" ${panel.page === 1 ? 'disabled' : ''}>‹ Prev</button>
      <span>Page ${panel.page} of ${totalPages} · ${totalItems} items</span>
      <button class="ghost" data-pg="next" type="button" ${panel.page === totalPages ? 'disabled' : ''}>Next ›</button>
    </div>`;
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
  $('cards').innerHTML =
    card(d.counts.partnerOutOfStock, 'In stock on Kapruka only', 'good') +
    card(d.counts.kaprukaOutOfStock, 'In stock at partner only', 'bad');
}

function countBy(items, key) {
  const map = new Map();
  for (const it of items) {
    const k = it[key];
    if (!k) continue;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

function allItems() {
  return [...DATA.partnerOutOfStock, ...DATA.kaprukaOutOfStock];
}

function categoryOptions() {
  const sel = $('category');
  const current = sel.value;
  const counts = countBy(allItems(), 'category');
  const cats = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} · ${counts.get(c)}</option>`).join('');
  sel.value = counts.has(current) ? current : '';
}

function storeOptions() {
  const sel = $('store');
  const current = sel.value;
  const category = $('category').value;
  const items = category ? allItems().filter((m) => m.category === category) : allItems();
  const byPartner = new Map();
  for (const m of items) {
    if (!m.partnerId) continue;
    const cur = byPartner.get(m.partnerId) || { name: m.partner, count: 0 };
    cur.count++;
    byPartner.set(m.partnerId, cur);
  }
  const ids = [...byPartner.keys()].sort((a, b) => byPartner.get(b).count - byPartner.get(a).count);
  sel.innerHTML = '<option value="">All stores</option>' +
    ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(byPartner.get(id).name)} · ${byPartner.get(id).count}</option>`).join('');
  sel.value = byPartner.has(current) ? current : '';
}

function filteredFor(dir) {
  const q = $('search').value.trim().toLowerCase();
  const store = $('store').value;
  const category = $('category').value;
  const source = dir === 'kapruka' ? DATA.kaprukaOutOfStock : DATA.partnerOutOfStock;
  return source.filter(
    (m) =>
      (!category || m.category === category) &&
      (!store || m.partnerId === store) &&
      (!q || m.name.toLowerCase().includes(q)),
  );
}

function wireToggle() {
  $('stockToggle').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dir === ACTIVE_DIR);
    btn.addEventListener('click', () => {
      if (btn.dataset.dir === ACTIVE_DIR) return;
      ACTIVE_DIR = btn.dataset.dir;
      $('stockToggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      render();
    });
  });
}

function render() {
  const panel = PANELS[ACTIVE_DIR];
  let rows = filteredFor(ACTIVE_DIR);
  $('activeCount').textContent = `${rows.length} product${rows.length === 1 ? '' : 's'}`;

  if (!rows.length) {
    $('activeTable').innerHTML = '<p class="empty">No stock mismatches match your filter. 🎉</p>';
    panel.rows = [];
    return;
  }

  rows = sortRows(rows, panel.sort);
  panel.rows = rows;

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  panel.page = Math.min(panel.page, totalPages);
  const pageRows = rows.slice((panel.page - 1) * PAGE_SIZE, panel.page * PAGE_SIZE);

  const body = pageRows
    .map((m) => {
      const conf = m.confidence === 'high'
        ? '<span class="badge b-hi">high</span>'
        : '<span class="badge b-md">review</span>';
      return `<tr class="${panel.rowClass}">
        <td>${escapeHtml(m.category)}</td>
        <td><span class="store-pill">${escapeHtml(m.partner)}</span></td>
        <td>${link(m.kaprukaUrl, m.name)}
          <div class="ctx">matched: ${link(m.partnerUrl, m.partnerLabel)} · ${conf} · name sim ${m.nameSimilarity ?? '—'}%</div></td>
        <td class="num price">${lkr(m.kaprukaPrice)}</td>
        <td class="num">${lkr(m.partnerPrice)}</td>
      </tr>`;
    })
    .join('');

  $('activeTable').innerHTML = `<div class="table-wrap"><table><thead>${theadHtml(panel.sort)}</thead>
    <tbody>${body}</tbody></table></div>${pagerHtml(panel, totalPages, rows.length)}`;

  $('activeTable').querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const col = COLUMNS.find((c) => c.key === key);
      if (panel.sort.key === key) panel.sort.dir = panel.sort.dir === 'asc' ? 'desc' : 'asc';
      else panel.sort = { key, dir: col.num ? 'desc' : 'asc' };
      panel.page = 1;
      render();
    });
  });
  $('activeTable').querySelectorAll('[data-pg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      panel.page = btn.dataset.pg === 'next' ? panel.page + 1 : panel.page - 1;
      render();
      $('activeTable').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  });
}

function footmeta() {
  if (!DATA.lastUpdated) {
    $('footmeta').textContent = 'No comparison data stored yet — the daily refresh will populate this shortly.';
    return;
  }
  const at = new Date(DATA.lastUpdated);
  $('footmeta').textContent =
    `Showing the latest stored comparison for each store · last updated ${at.toLocaleString()} · ` +
    'refreshes automatically once a day. Stock status only reflects runs scraped since stock detection ' +
    'was added — a partner needs a fresh run (hit "Refresh" on the Comparison page) before it shows up here.';
}

function paint() {
  statCards(DATA);
  categoryOptions();
  storeOptions();
  wireToggle();
  render();
  footmeta();
  $('status').style.display = 'none';
  $('app').style.display = '';
}

async function load() {
  try {
    const res = await fetch('/api/stock-mismatch');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    DATA = data;
    paint();
  } catch (err) {
    $('status').innerHTML = `Error: ${escapeHtml(err.message)} <button class="ghost" onclick="location.reload()">Retry</button>`;
  }
}

function exportCsv(dir) {
  const storeSel = $('store');
  const storeId = storeSel.value;
  const category = $('category').value;
  const base = '/api/export/stock-mismatch.csv?direction=' + dir;

  if (storeId || category) {
    const parts = [];
    if (category) parts.push(`category "${category}"`);
    if (storeId) parts.push(`store "${storeSel.options[storeSel.selectedIndex].textContent}"`);
    const onlyFiltered = confirm(
      `You've filtered by ${parts.join(', ')}. Export only the filtered products?\n\nOK = filtered only\nCancel = every mismatch in this list`,
    );
    if (onlyFiltered) {
      const params = new URLSearchParams();
      if (storeId) params.set('partner', storeId);
      if (category) params.set('category', category);
      window.location.href = base + '&' + params.toString();
      return;
    }
  }
  window.location.href = base;
}

$('search').addEventListener('input', () => { PANELS.partner.page = 1; PANELS.kapruka.page = 1; render(); });
$('category').addEventListener('change', () => { PANELS.partner.page = 1; PANELS.kapruka.page = 1; storeOptions(); render(); });
$('store').addEventListener('change', () => { PANELS.partner.page = 1; PANELS.kapruka.page = 1; render(); });
$('activeExport').addEventListener('click', () => exportCsv(ACTIVE_DIR));

load();
