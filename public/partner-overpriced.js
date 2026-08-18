const $ = (id) => document.getElementById(id);
let DATA = null;
let PAGE = 1;
const PAGE_SIZE = 50;
let CURRENT_ROWS = []; // the filtered+sorted rows behind the currently rendered page — see wireRemoveButtons()

const COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'partner', label: 'Store' },
  { key: 'name', label: 'Product' },
  { key: 'nameSimilarity', label: 'Name Sim %', num: true },
  { key: 'kaprukaPrice', label: 'Kapruka', num: true },
  { key: 'partnerPrice', label: 'Partner site', num: true },
  { key: 'diff', label: 'Overcharge', num: true },
  { key: 'pct', label: '%', num: true },
  { key: 'fairnessSort', label: 'AI Fairness', num: true },
];

const FAIRNESS_LABEL = {
  genuine_problem: { text: '⚠️ Needs attention', cls: 'status-warn' },
  explainable: { text: '✓ Explainable', cls: 'status-ok' },
  uncertain_match: { text: '❔ Uncertain match', cls: 'status-warn' },
};
// Sort weight, HIGHEST first — clicking the column header defaults to
// descending for numeric columns, so "needs attention" naturally floats to
// the top on first click, and unreviewed items (nothing to show yet) sort
// to the very bottom rather than mixing in with real verdicts.
const FAIRNESS_SORT_WEIGHT = { genuine_problem: 3, uncertain_match: 2, explainable: 1 };
function fairnessCell(m) {
  if (!m.fairness) return `<span class="ctx">not reviewed</span>`;
  const label = FAIRNESS_LABEL[m.fairness.verdict] || FAIRNESS_LABEL.uncertain_match;
  const reasoning = m.fairness.reasoning ? `<div class="ctx">${escapeHtml(m.fairness.reasoning)}</div>` : '';
  return `<span class="${label.cls}">${label.text}</span>${reasoning}`;
}
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
  return `<tr>${cells}<th></th></tr>`;
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

// A badge when the partner's own site shows this as discounted from its
// regular price (regular_price on WooCommerce, compare_at_price on Shopify —
// see partnerRegularPrice in matcher.js). Not related to our overcharge —
// this is about whether *they're* currently running a sale.
function discountBadge(regular, price) {
  if (regular == null || price == null || regular <= price) return '';
  const pct = Math.round(((regular - price) / regular) * 100);
  return ` <span class="badge b-hi" title="Partner regular price: ${lkr(regular)}">🏷 -${pct}%</span>`;
}

function statCards(d) {
  const card = (n, l, cls = '') => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const stores = d.partners.filter((p) => p.overpriced > 0).length;
  $('cards').innerHTML =
    card(d.count, 'Overpriced products', 'bad') +
    card(stores + ' / ' + d.partners.length, 'Stores affected') +
    card(lkr(Math.round(d.totalOvercharge)), 'Total overcharge', 'bad');
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

// Category options always reflect the full dataset (not narrowed by the
// store filter) — category is the primary filter, store is secondary/
// cascading off it. See storeOptions() below.
function categoryOptions() {
  const sel = $('category');
  const current = sel.value;
  const counts = countBy(DATA.items, 'category');
  const cats = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} · ${counts.get(c)}</option>`).join('');
  sel.value = counts.has(current) ? current : '';
}

// Store options are scoped to whatever category is currently selected, so
// picking a category first narrows the store list to only stores that
// actually have overpriced items in that category.
function storeOptions() {
  const sel = $('store');
  const current = sel.value;
  const category = $('category').value;
  const items = category ? DATA.items.filter((m) => m.category === category) : DATA.items;
  const byPartner = new Map(); // partnerId -> { name, count }
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
  let rows = DATA.items.filter(
    (m) =>
      (!category || m.category === category) &&
      (!store || m.partnerId === store) &&
      (!q || m.name.toLowerCase().includes(q)),
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
      return `<tr class="over">
        <td>${escapeHtml(m.category)}</td>
        <td><span class="store-pill">${escapeHtml(m.partner)}</span>${m.partnerLabel ? `<div class="ctx">${escapeHtml(m.partnerLabel)}</div>` : ''}</td>
        <td class="col-product">
          <div class="prod-name">${link(m.kaprukaUrl, m.name)}</div>
          <div class="prod-name prod-partner">${link(m.partnerUrl, m.partnerProductName || m.partnerLabel || '—')}</div>
        </td>
        <td class="num">${m.nameSimilarity != null ? m.nameSimilarity + '%' : '—'}</td>
        <td class="num price">${lkr(m.kaprukaPrice)}</td>
        <td class="num">${lkr(m.partnerPrice)}${discountBadge(m.partnerRegularPrice, m.partnerPrice)}</td>
        <td class="num over-amt">+${lkr(m.diff)}</td>
        <td class="num over-amt">${pct}</td>
        <td>${fairnessCell(m)}</td>
        <td><button type="button" class="row-remove" data-idx="${(PAGE - 1) * PAGE_SIZE + i}" title="Remove from dashboard">🗑 Remove</button></td>
      </tr>`;
    })
    .join('');

  $('table').innerHTML = `<div class="table-wrap"><table><thead>${theadHtml()}</thead>
    <tbody>${body}</tbody></table></div>${pagerHtml(totalPages, rows.length)}`;
  wirePager(totalPages);
  wireSort();
  wireRemoveButtons();
}

// Wires each row's Remove button: opens the shared reason modal, POSTs the
// removal, then reloads /api/overpriced (which already excludes removed
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
          partnerName: m.partner,
          sourcePage: 'partner-overpriced',
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
  categoryOptions();
  storeOptions();
  render();
  footmeta();
  $('status').style.display = 'none';
  $('app').style.display = '';
  refreshRemovedCount();
  const btn = $('fairnessReview');
  btn.textContent = DATA.unreviewedCount > 0
    ? `🤖 Run AI Fairness Review (${DATA.unreviewedCount} unreviewed)`
    : '🤖 AI Fairness Review — all caught up';
  btn.disabled = DATA.unreviewedCount === 0;
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

// Flatten each item's nested `fairness` object into a sortable field, and
// count how many still need a review so the button can show progress.
function annotateFairness(data) {
  let unreviewed = 0;
  for (const m of data.items) {
    m.fairnessSort = m.fairness ? FAIRNESS_SORT_WEIGHT[m.fairness.verdict] ?? 2 : 0;
    if (!m.fairness) unreviewed++;
  }
  data.unreviewedCount = unreviewed;
  return data;
}

async function load() {
  try {
    const res = await fetch('/api/overpriced');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    DATA = annotateFairness(data);
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
    DATA = annotateFairness(data);
    paint();
  } catch (err) {
    alert('Refresh failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Reviews a batch of not-yet-reviewed items (see /api/overpriced/fairness-
// review) and repaints with the results. One batch at a time (not "review
// everything") since it's an LLM call per item — the button just shows how
// many are left and can be clicked again.
async function runFairnessReviewBatch() {
  const btn = $('fairnessReview');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>Reviewing…';
  try {
    const res = await fetch('/api/overpriced/fairness-review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 20 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'review failed');
    DATA = annotateFairness(data);
    paint();
  } catch (err) {
    alert('Fairness review failed: ' + err.message);
    btn.textContent = prev;
    btn.disabled = false;
  }
}

function exportCsv() {
  const storeSel = $('store');
  const storeId = storeSel.value;
  const category = $('category').value;

  if (storeId || category) {
    const parts = [];
    if (category) parts.push(`category "${category}"`);
    if (storeId) parts.push(`store "${storeSel.options[storeSel.selectedIndex].textContent}"`);
    const onlyFiltered = confirm(
      `You've filtered by ${parts.join(', ')}. Export only the filtered products?\n\nOK = filtered only\nCancel = every overpriced product`,
    );
    if (onlyFiltered) {
      const params = new URLSearchParams();
      if (storeId) params.set('partner', storeId);
      if (category) params.set('category', category);
      window.location.href = '/api/export/overpriced.csv?' + params.toString();
      return;
    }
  }
  window.location.href = '/api/export/overpriced.csv';
}

$('search').addEventListener('input', () => { PAGE = 1; render(); });
$('category').addEventListener('change', () => { PAGE = 1; storeOptions(); render(); });
$('store').addEventListener('change', () => { PAGE = 1; render(); });
$('exportCsv').addEventListener('click', exportCsv);
$('refresh').addEventListener('click', refreshNow);
$('fairnessReview').addEventListener('click', runFairnessReviewBatch);
$('toggleRemoved').addEventListener('click', toggleRemovedSection);

load();
