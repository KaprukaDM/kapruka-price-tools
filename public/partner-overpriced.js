const $ = (id) => document.getElementById(id);
let DATA = null;
let PAGE = 1;

// "Hide offline stores" defaults to ON: a store whose site is dead can't sell
// at the price we last saw, so leaving it in the list invites us to cut our
// own margin to beat a competitor that isn't taking orders. The user's own
// choice is remembered per browser and wins over the default; the default
// only applies when nothing has been stored yet.
const HIDE_OFFLINE_KEY = 'partnerOverpriced.hideOffline';
function restoreHideOffline() {
  let stored = null;
  try { stored = localStorage.getItem(HIDE_OFFLINE_KEY); } catch { /* private mode */ }
  $('hideOffline').checked = stored == null ? true : stored === '1';
}
function saveHideOffline() {
  try { localStorage.setItem(HIDE_OFFLINE_KEY, $('hideOffline').checked ? '1' : '0'); } catch { /* private mode */ }
}
restoreHideOffline();
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

// The headline numbers follow the offline filter. They used to be the raw
// totals from /api/overpriced, which meant "Total overcharge" quietly included
// the gap against stores that can't take an order — the one number people
// quote when arguing for a price cut, inflated by competitors who don't exist.
function statCards(d) {
  const card = (n, l, cls = '') => `<div class="stat ${cls}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const hideOffline = $('hideOffline').checked;
  const items = hideOffline ? d.items.filter((i) => i.siteActive !== false) : d.items;
  const partners = hideOffline ? d.partners.filter((p) => p.siteActive !== false) : d.partners;
  const stores = partners.filter((p) => p.overpriced > 0).length;
  const total = items.reduce((sum, i) => sum + (i.diff ?? 0), 0);
  const excluded = d.count - items.length;
  $('cards').innerHTML =
    card(items.length, 'Overpriced products', 'bad') +
    card(stores + ' / ' + partners.length, 'Stores affected') +
    card(lkr(Math.round(total)), 'Total overcharge', 'bad') +
    (excluded > 0
      ? card(excluded, 'Hidden — offline stores')
      : '');
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

// The rows in scope for building ONE dropdown's options: everything the other
// filters currently allow. `except` names the dropdown being rebuilt, so it's
// never narrowed by its own selection (that would prune it down to the single
// value already picked).
function itemsForOptions(except) {
  const category = $('category').value;
  const store = $('store').value;
  const hideOffline = $('hideOffline').checked;
  return DATA.items.filter(
    (m) =>
      (except === 'category' || !category || m.category === category) &&
      (except === 'store' || !store || m.partnerId === store) &&
      (!hideOffline || m.siteActive !== false),
  );
}

// Categories are scoped to the selected store, so every category on offer
// actually falls inside that partner — and its count is that partner's count,
// not a site-wide one. Listing all 16 categories regardless of store was a
// dead end: picking one the store has nothing in just emptied the table.
// Offline stores' categories drop out while offline stores are hidden, same
// rule storeOptions() applies to the stores themselves.
function categoryOptions() {
  const sel = $('category');
  const current = sel.value;
  const counts = countBy(itemsForOptions('category'), 'category');
  const cats = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} · ${counts.get(c)}</option>`).join('');
  sel.value = counts.has(current) ? current : '';
}

// Store options are scoped to whatever category is currently selected, so
// picking a category first narrows the store list to only stores that
// actually have overpriced items in that category. Offline stores drop out
// of the list entirely while they're being hidden — offering a store you'd
// then be told has nothing to show is just a dead end.
function storeOptions() {
  const sel = $('store');
  const current = sel.value;
  const items = itemsForOptions('store');
  const byPartner = new Map(); // partnerId -> { name, count, offline }
  for (const m of items) {
    if (!m.partnerId) continue;
    const cur = byPartner.get(m.partnerId) || { name: m.partner, count: 0, offline: m.siteActive === false };
    cur.count++;
    byPartner.set(m.partnerId, cur);
  }
  const ids = [...byPartner.keys()].sort((a, b) => byPartner.get(b).count - byPartner.get(a).count);
  sel.innerHTML = '<option value="">All stores</option>' +
    ids.map((id) => {
      const p = byPartner.get(id);
      const prefix = p.offline ? '⚠️ ' : '';
      return `<option value="${escapeHtml(id)}">${prefix}${escapeHtml(p.name)} · ${p.count}</option>`;
    }).join('');
  sel.value = byPartner.has(current) ? current : '';
}

// Plain-English version of the siteStatus reason set by checkSiteHealth()
// in src/compare/sources.js.
const OFFLINE_REASONS = {
  unreachable: 'no response at all',
  server_error: 'server error',
  origin_missing: 'shop front page is gone',
  storefront_dead: 'home page loads but no product page opens',
  empty_catalogue: 'site lists no products',
};
const offlineReason = (s) => OFFLINE_REASONS[s] || 'site unreachable';

// A store that failed its health check on its last refresh (see
// checkSiteHealth() in compare/sources.js) -- its rows below are the last
// known-good comparison, kept on display rather than dropped, but nobody can
// buy at those prices today, so they're hidden by default and only shown when
// someone deliberately unticks "Hide offline stores".
function offlineBanner() {
  const offline = DATA.partners.filter((p) => p.siteActive === false);
  if (!offline.length) { $('offlineBanner').innerHTML = ''; return; }
  const names = offline
    .map((p) => `${escapeHtml(p.partnerLabel || p.name)} <span class="ctx">(${escapeHtml(offlineReason(p.siteStatus))})</span>`)
    .join(', ');
  const hidden = $('hideOffline').checked;
  $('offlineBanner').innerHTML = `<div class="offline-banner">
    ⚠️ <strong>${offline.length} store${offline.length === 1 ? '' : 's'} appear offline</strong>
    — ${hidden ? 'hidden from the list below' : 'shown below'}, because their last known prices
    aren't something a customer can buy today: ${names}
  </div>`;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const store = $('store').value;
  const category = $('category').value;
  const hideOffline = $('hideOffline').checked;
  let rows = DATA.items.filter(
    (m) =>
      (!category || m.category === category) &&
      (!store || m.partnerId === store) &&
      (!hideOffline || m.siteActive !== false) &&
      (!q || m.name.toLowerCase().includes(q)),
  );

  if (!rows.length) {
    // Don't say "nothing to see here 🎉" when the only reason the list is
    // empty is that the offline filter swallowed everything.
    const hiddenByOffline = hideOffline && DATA.items.some(
      (m) => m.siteActive === false &&
        (!category || m.category === category) &&
        (!store || m.partnerId === store) &&
        (!q || m.name.toLowerCase().includes(q)),
    );
    $('table').innerHTML = hiddenByOffline
      ? '<p class="empty">Everything matching this filter belongs to a store that\'s offline, so it\'s hidden. Untick “Hide offline stores” to see the last prices we saw there.</p>'
      : '<p class="empty">No overpriced products match your filter. 🎉</p>';
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
        <td><span class="store-pill">${escapeHtml(m.partner)}</span>${m.siteActive === false ? ` <span class="badge badge-offline" title="Offline on last check: ${escapeHtml(offlineReason(m.siteStatus))} — this price is the last one we saw, not one a customer can buy at today">⚠️ offline</span>` : ''}${m.partnerLabel ? `<div class="ctx">${escapeHtml(m.partnerLabel)}</div>` : ''}</td>
        <td class="col-product">
          <div class="prod-name">${link(m.kaprukaUrl, m.name)}</div>
          <div class="prod-name prod-partner">${link(m.partnerUrl, m.partnerProductName || m.partnerLabel || '—')}</div>
        </td>
        <td class="num">${m.nameSimilarity != null ? m.nameSimilarity + '%' : '—'}</td>
        <td class="num price">${lkr(m.kaprukaPrice)}</td>
        <td class="num">${lkr(m.partnerPrice)}${discountBadge(m.partnerRegularPrice, m.partnerPrice)}</td>
        <td class="num over-amt">+${lkr(m.diff)}</td>
        <td class="num over-amt">${pct}</td>
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
    $('footmeta').textContent = 'No comparison data stored yet — the scheduled refresh above will populate this shortly.';
    return;
  }
  const at = new Date(DATA.lastUpdated);
  $('footmeta').textContent =
    `Showing the latest stored comparison for each store · last updated ${at.toLocaleString()} · ` +
    'refresh schedule is shown at the top of this page. "Overcharge" = Kapruka price − partner-site price.';
}

// ---- Scheduled refresh panel ----------------------------------------------
// The 15-minute "new & requested stores" refresh used to be a Windows
// scheduled task nobody could see; it now runs inside the app and reports
// itself through GET /api/schedule, which is what this renders.
let SCHEDULE = null;

function relTime(iso) {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const txt = mins < 1 ? 'less than a minute' : mins < 60
    ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return diff < 0 ? `${txt} ago` : `in ${txt}`;
}

function everyLabel(ms) {
  const mins = Math.round(ms / 60000);
  return mins < 60 ? `every ${mins} min` : `every ${+(mins / 60).toFixed(2)}h`;
}

function scheduleJobHtml(j, enabled) {
  const dot = j.running ? 'dot-run' : enabled ? 'dot-on' : 'dot-off';
  const state = j.running ? 'running now' : enabled ? 'scheduled' : 'paused';
  const last = j.lastRunAt
    ? `${new Date(j.lastRunAt).toLocaleString()} <span class="ctx">(${relTime(j.lastRunAt)})</span>`
    : 'not since this server started';
  const next = j.running ? 'running now…'
    : j.nextRunAt ? `${new Date(j.nextRunAt).toLocaleTimeString()} <span class="ctx">(${relTime(j.nextRunAt)})</span>`
    : 'paused — run it manually';
  const result = j.lastError
    ? `<span style="color:var(--bad)">✗ ${escapeHtml(j.lastError)}</span>`
    : j.lastResult
      ? escapeHtml(j.lastResult.summary || 'done') +
        (j.lastResult.durationMs ? ` <span class="ctx">(${Math.round(j.lastResult.durationMs / 1000)}s)</span>` : '')
      : '—';
  return `<div class="sched-job">
    <div class="jname"><span class="${dot}" title="${state}"></span>${escapeHtml(j.name)}</div>
    <div class="jdesc">${escapeHtml(j.description)}</div>
    <dl>
      <dt>Runs</dt><dd>${everyLabel(j.intervalMs)}</dd>
      <dt>Last run</dt><dd>${last}</dd>
      <dt>Next run</dt><dd>${next}</dd>
      <dt>Last result</dt><dd>${result}</dd>
    </dl>
    <div class="jfoot">
      <button class="ghost sched-run" type="button" data-job="${escapeHtml(j.id)}" ${j.running ? 'disabled' : ''}>
        ${j.running ? 'Running…' : '▶ Run now'}</button>
    </div>
  </div>`;
}

function renderSchedule() {
  const el = $('schedule');
  if (!SCHEDULE) { el.style.display = 'none'; return; }
  const notes = [];
  if (!SCHEDULE.enabled) {
    notes.push(`<div class="sched-note warn">⏸ Automatic runs are switched off on this instance (${escapeHtml(SCHEDULE.disabledReason || 'disabled')}) —
      the jobs only run when someone presses “Run now”.</div>`);
  }
  if (!SCHEDULE.trustedScrapeHost) {
    notes.push(`<div class="sched-note warn">⚠️ This instance isn't the trusted Sri-Lanka-geo scraper (<code>SCRAPE_ON_ADD</code> unset),
      so it queues refresh requests instead of scraping Kapruka itself.</div>`);
  }
  notes.push(`<div class="sched-note">Storage: ${escapeHtml(SCHEDULE.storage)} · server up since ${new Date(SCHEDULE.serverStartedAt).toLocaleString()}.
    These jobs run inside this app — there's no separate scheduled task behind the scenes.</div>`);

  el.innerHTML = `<h2>⏱ Scheduled refresh</h2>
    <div class="sched-jobs">${SCHEDULE.jobs.map((j) => scheduleJobHtml(j, SCHEDULE.enabled)).join('')}</div>
    ${notes.join('')}`;
  el.style.display = '';
  el.querySelectorAll('.sched-run').forEach((btn) => {
    btn.addEventListener('click', () => runScheduledJob(btn));
  });
}

async function loadSchedule() {
  try {
    const res = await fetch('/api/schedule');
    SCHEDULE = await res.json();
    renderSchedule();
  } catch {
    /* the panel is informational — a failed poll shouldn't break the page */
  }
}

async function runScheduledJob(btn) {
  const id = btn.dataset.job;
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Running…';
  try {
    const res = await fetch(`/api/schedule/${id}/run`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'run failed');
    SCHEDULE = data;
    renderSchedule();
    await load(); // job may have written new runs — repaint the table
  } catch (err) {
    alert('Job failed: ' + err.message);
    loadSchedule();
  }
}

function paint() {
  statCards(DATA);
  offlineBanner();
  categoryOptions();
  storeOptions();
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
    if (data.message) alert(data.message);
  } catch (err) {
    alert('Refresh failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
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
// Each dropdown rebuilds the other one after a change (and then itself, so its
// own counts follow a selection the rebuild may have had to clear).
$('category').addEventListener('change', () => { PAGE = 1; storeOptions(); categoryOptions(); render(); });
$('store').addEventListener('change', () => { PAGE = 1; categoryOptions(); storeOptions(); render(); });
$('hideOffline').addEventListener('change', () => {
  PAGE = 1;
  saveHideOffline();
  statCards(DATA); // headline totals follow the filter
  offlineBanner(); // the banner says whether those stores are hidden or shown
  categoryOptions(); // ditto for categories that only offline stores had
  storeOptions(); // offline stores appear/disappear from the dropdown
  render();
});
$('exportCsv').addEventListener('click', exportCsv);
$('refresh').addEventListener('click', refreshNow);
$('toggleRemoved').addEventListener('click', toggleRemovedSection);

load();
loadSchedule();
// Keeps "next run in …" honest without a page reload, and shows a job that
// started on its own timer while the page was open.
setInterval(loadSchedule, 30000);
