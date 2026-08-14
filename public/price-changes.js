const $ = (id) => document.getElementById(id);
let DATA = null;
let PAGE = 1;
const PAGE_SIZE = 50;

const COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'partner', label: 'Store' },
  { key: 'name', label: 'Product' },
  { key: 'kaprukaPrice', label: 'Kapruka Price', num: true },
  { key: 'previousPrice', label: 'Previous', num: true },
  { key: 'currentPrice', label: 'Current', num: true },
  { key: 'diff', label: 'Change', num: true },
  { key: 'pct', label: '%', num: true },
];
let SORT = { key: 'diff', dir: 'desc' };

function absSort(a, b, mul) {
  return (Math.abs(a) - Math.abs(b)) * mul;
}

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
      // "Change" sorts by size of the move, not sign, so increases and
      // decreases of the same magnitude rank together.
      if (SORT.key === 'diff') return absSort(av, bv, mul);
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
  return `<tr>${cells}<th>Direction</th></tr>`;
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
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-LK', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
function link(url, text) {
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>` : escapeHtml(text);
}

// Only a partner CUTTING their price is competitively alarming — a partner
// raising their price isn't, so only "decreased" rows get colored at all.
// The shade of red scales with how big the cut is, so a 2% trim and a 50%
// slash are visibly different at a glance instead of both just being "red".
function reducedShade(pctAbs) {
  if (pctAbs >= 50) return { bg: '#7a170f', fg: '#fff' };
  if (pctAbs >= 25) return { bg: '#c0392b', fg: '#fff' };
  if (pctAbs >= 10) return { bg: '#e8897d', fg: '#4a120c' };
  return { bg: '#fbdedb', fg: '#5c1912' };
}

function statCards(d) {
  const card = (n, l, cls = '') => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  $('cards').innerHTML =
    card(d.count, 'Products with a price change', d.count ? 'bad' : '') +
    card(d.increasedCount, 'Prices increased', 'bad') +
    card(d.decreasedCount, 'Prices decreased', 'good') +
    card(`${d.partnersChecked} / ${d.partnersTotal}`, 'Stores with 2+ scrapes to compare');
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

function categoryOptions() {
  const sel = $('category');
  const current = sel.value;
  const counts = countBy(DATA.items, 'category');
  const cats = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} · ${counts.get(c)}</option>`).join('');
  sel.value = counts.has(current) ? current : '';
}

function storeOptions() {
  const sel = $('store');
  const current = sel.value;
  const category = $('category').value;
  const items = category ? DATA.items.filter((m) => m.category === category) : DATA.items;
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

function render() {
  const q = $('search').value.trim().toLowerCase();
  const store = $('store').value;
  const category = $('category').value;
  const direction = $('direction').value;
  let rows = DATA.items.filter(
    (m) =>
      (!category || m.category === category) &&
      (!store || m.partnerId === store) &&
      (!direction || m.direction === direction) &&
      (!q || m.name.toLowerCase().includes(q)),
  );

  if (!rows.length) {
    $('table').innerHTML = '<p class="empty">No competitor price changes match your filter.</p>';
    return;
  }

  rows = sortRows(rows);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  PAGE = Math.min(PAGE, totalPages);
  const pageRows = rows.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE);

  const body = pageRows
    .map((m) => {
      const up = m.direction === 'increased';
      const pct = m.pct == null ? '' : `${up ? '+' : ''}${m.pct.toFixed(1)}%`;
      const rowStyle = up ? '' : (() => {
        const { bg, fg } = reducedShade(Math.abs(m.pct ?? 0));
        return ` style="background:${bg};color:${fg};"`;
      })();
      return `<tr class="${up ? 'up' : 'down'}"${rowStyle}>
        <td>${escapeHtml(m.category)}</td>
        <td><span class="store-pill">${escapeHtml(m.partner)}</span>${m.partnerLabel ? `<div class="ctx">${escapeHtml(m.partnerLabel)}</div>` : ''}</td>
        <td class="col-product">
          <div class="prod-name">${link(m.kaprukaUrl, m.name)}</div>
          <div class="prod-name prod-partner">${link(m.partnerUrl, m.partnerProductName || '—')}</div>
        </td>
        <td class="num">${lkr(m.kaprukaPrice)}</td>
        <td class="num">${lkr(m.previousPrice)}<div class="ctx">${shortDate(m.previousScrapedAt)}</div></td>
        <td class="num price">${lkr(m.currentPrice)}<div class="ctx">${shortDate(m.currentScrapedAt)}</div></td>
        <td class="num ${up ? 'move-up' : 'move-down'}">${up ? '+' : ''}${lkr(m.diff)}</td>
        <td class="num ${up ? 'move-up' : 'move-down'}">${pct}</td>
        <td><span class="dir-badge ${up ? 'up' : 'down'}">${up ? '▲ Up' : '▼ Down'}</span></td>
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
    $('footmeta').textContent = 'No comparison history stored yet — need at least two scrapes per store to compare.';
    return;
  }
  const at = new Date(DATA.lastUpdated);
  $('footmeta').textContent =
    `Comparing each store's two most recent stored scrapes · latest scrape used ${at.toLocaleString()} · ` +
    '"Change" = current competitor price − previous competitor price.';
}

function paint() {
  statCards(DATA);
  categoryOptions();
  storeOptions();
  render();
  footmeta();
  $('status').style.display = 'none';
  $('app').style.display = '';
}

async function load() {
  try {
    const res = await fetch('/api/price-changes');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    DATA = data;
    paint();
  } catch (err) {
    $('status').innerHTML = `Error: ${escapeHtml(err.message)} <button class="ghost" onclick="location.reload()">Retry</button>`;
  }
}

function exportCsv() {
  const storeSel = $('store');
  const storeId = storeSel.value;
  const direction = $('direction').value;

  if (storeId || direction) {
    const parts = [];
    if (direction) parts.push(`direction "${direction}"`);
    if (storeId) parts.push(`store "${storeSel.options[storeSel.selectedIndex].textContent}"`);
    const onlyFiltered = confirm(
      `You've filtered by ${parts.join(', ')}. Export only the filtered products?\n\nOK = filtered only\nCancel = every price change`,
    );
    if (onlyFiltered) {
      const params = new URLSearchParams();
      if (storeId) params.set('partner', storeId);
      if (direction) params.set('direction', direction);
      window.location.href = '/api/export/price-changes.csv?' + params.toString();
      return;
    }
  }
  window.location.href = '/api/export/price-changes.csv';
}

$('search').addEventListener('input', () => { PAGE = 1; render(); });
$('category').addEventListener('change', () => { PAGE = 1; storeOptions(); render(); });
$('store').addEventListener('change', () => { PAGE = 1; render(); });
$('direction').addEventListener('change', () => { PAGE = 1; render(); });
$('exportCsv').addEventListener('click', exportCsv);

load();
