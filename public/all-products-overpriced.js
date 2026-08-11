const $ = (id) => document.getElementById(id);
let DATA = null;
let PAGE = 1;
const PAGE_SIZE = 50;
let CURRENT_ROWS = []; // the filtered+sorted rows behind the currently rendered page — see wireRemoveButtons()

const COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'name', label: 'Product' },
  { key: 'kaprukaPrice', label: 'Kapruka', num: true },
  { key: 'partnerPrice', label: 'Partner price', num: true },
  { key: 'bestPrice', label: 'Best price found', num: true },
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
  const withPartner = d.items.filter((i) => i.partner).length;
  $('cards').innerHTML =
    card(d.count, 'Overpriced products', 'bad') +
    card(withPartner, 'Carried by a partner') +
    card(lkr(Math.round(d.totalOvercharge)), 'Total overcharge (vs. best price found)', 'bad');
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

function otherSitesHtml(item) {
  if (!item.otherSites.length) return '<span class="none">—</span>';
  return item.otherSites
    .map(
      (s) =>
        `<a class="other-pill store-pill" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name)} · ${lkr(s.price)}</a>`,
    )
    .join('');
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const category = $('category').value;
  let rows = DATA.items.filter(
    (m) => (!category || m.category === category) && (!q || m.name.toLowerCase().includes(q)),
  );

  if (!rows.length) {
    $('table').innerHTML = '<p class="empty">No overpriced products match your filter. 🎉</p>';
    return;
  }

  rows = sortRows(rows);
  CURRENT_ROWS = rows;

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  PAGE = Math.min(PAGE, totalPages);
  const pageRows = rows.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE);

  const body = pageRows
    .map((m, i) => {
      const pct = m.pct == null ? '' : `+${m.pct.toFixed(1)}%`;
      const partnerCell = m.partner
        ? `${link(m.partner.url, m.partner.name)}<div class="ctx price">${lkr(m.partner.price)}</div>`
        : '<span class="none">no partner</span>';
      return `<tr class="over">
        <td>${escapeHtml(m.category)}</td>
        <td>${link(m.kaprukaUrl, m.name)}</td>
        <td class="num price">${lkr(m.kaprukaPrice)}</td>
        <td>${partnerCell}</td>
        <td>${otherSitesHtml(m)}</td>
        <td class="num price">${link(m.bestUrl, lkr(m.bestPrice))}<div class="ctx">${escapeHtml(m.bestName || '')}</div></td>
        <td class="num over-amt">+${lkr(m.diff)}</td>
        <td class="num over-amt">${pct}</td>
        <td><button type="button" class="row-remove" data-idx="${(PAGE - 1) * PAGE_SIZE + i}" title="Remove from dashboard">🗑 Remove</button></td>
      </tr>`;
    })
    .join('');

  // Columns rendered above (category, product, kapruka, partner, cheaper
  // elsewhere, best price, overcharge, %) — one extra "Cheaper elsewhere"
  // header not in COLUMNS since it's a free-form list, not a sortable value,
  // plus a trailing unsortable "Remove" action header.
  const theadCells = [
    ...COLUMNS.slice(0, 4).map((c) => headCell(c)),
    '<th>Cheaper elsewhere</th>',
    ...COLUMNS.slice(4).map((c) => headCell(c)),
    '<th></th>',
  ].join('');

  $('table').innerHTML = `<div class="table-wrap"><table><thead><tr>${theadCells}</tr></thead>
    <tbody>${body}</tbody></table></div>${pagerHtml(totalPages, rows.length)}`;
  wirePager(totalPages);
  wireSort();
  wireRemoveButtons();
}

// Wires each row's Remove button: opens the shared reason modal, POSTs the
// removal, then reloads /api/overpriced/all (which already excludes removed
// products server-side) so this table and the stat cards stay in sync.
function wireRemoveButtons() {
  $('table').querySelectorAll('.row-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const m = CURRENT_ROWS[Number(btn.dataset.idx)];
      if (!m) return;
      btn.disabled = true;
      try {
        const removed = await RemovedProducts.removeWithPrompt({
          kaprukaUrl: m.kaprukaUrl,
          name: m.name,
          category: m.category,
          partnerName: m.partner?.name || '',
          sourcePage: 'all-products-overpriced',
          snapshot: m,
        });
        if (removed) await load();
        else btn.disabled = false;
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

function headCell(c) {
  const active = SORT.key === c.key;
  const arrow = active ? (SORT.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}">${c.label}${arrow}</th>`;
}

function footmeta() {
  $('footmeta').textContent =
    'Combines configured partner reconciliation (comparison_runs) and the 5-category scraped-catalogue ' +
    'audit (price_audit_items) — computed live from current data each time this page loads. ' +
    '"Overcharge" = Kapruka price − the cheapest price found anywhere for that product.';
}

function paint() {
  statCards(DATA);
  categoryOptions();
  render();
  footmeta();
  $('status').style.display = 'none';
  $('app').style.display = '';
  refreshRemovedCount();
}

async function refreshRemovedCount() {
  const n = await RemovedProducts.count();
  const badge = $('removedCount');
  badge.hidden = !n;
  badge.textContent = n;
}

function toggleRemovedSection() {
  const showingRemoved = $('removedSection').style.display !== 'none';
  if (showingRemoved) {
    $('removedSection').style.display = 'none';
    $('table').style.display = '';
    $('toggleRemovedLabel').textContent = '🗑 Removed Products';
  } else {
    $('table').style.display = 'none';
    $('removedSection').style.display = '';
    $('toggleRemovedLabel').textContent = '← Back to overpriced products';
    RemovedProducts.renderInto($('removedSection'), () => { refreshRemovedCount(); load(); });
  }
}

async function load() {
  try {
    const res = await fetch('/api/overpriced/all');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    DATA = data;
    paint();
  } catch (err) {
    $('status').innerHTML = `Error: ${escapeHtml(err.message)} <button class="ghost" onclick="location.reload()">Retry</button>`;
  }
}

$('search').addEventListener('input', () => { PAGE = 1; render(); });
$('category').addEventListener('change', () => { PAGE = 1; render(); });
$('refresh').addEventListener('click', load);
$('toggleRemoved').addEventListener('click', toggleRemovedSection);

load();
