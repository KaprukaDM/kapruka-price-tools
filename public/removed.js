// Shared "Removed Products" module used by compare.js, partner-overpriced.js
// and all-products-overpriced.js. A product removed from any one of those
// dashboards is stored server-side (keyed by its Kapruka URL — see
// /api/removed-products in src/server.js) and filtered out of every
// dashboard's reports, so this same module renders the shared Removed
// Products table on all three pages and lets the team restore an item from
// any of them.
const RemovedProducts = (function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }
  const lkr = (v) => (v == null ? '—' : 'Rs.' + Number(v).toLocaleString('en-LK'));
  function link(url, text) {
    return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>` : escapeHtml(text);
  }

  // The removal snapshot's shape differs slightly per source dashboard
  // (partner-overpriced/compare carry a matched partner *product*; all-products
  // carries either a configured partner or a "best price found" site) — these
  // normalize whichever fields are present into one shape for the table.
  function otherName(s) {
    return (s && (s.partnerProductName || s.partnerName || s.partner?.name || s.bestName)) || '';
  }
  function otherUrl(s) {
    return (s && (s.partnerUrl || s.partner?.url || s.bestUrl)) || '';
  }
  function otherPrice(s) {
    if (!s) return null;
    if (s.partnerPrice != null) return s.partnerPrice;
    if (s.partner?.price != null) return s.partner.price;
    return s.bestPrice ?? null;
  }

  async function list() {
    const res = await fetch('/api/removed-products');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load removed products');
    return data;
  }

  async function remove({ kaprukaUrl, name, category, partnerName, sourcePage, snapshot, reason, removedBy, matchScope }) {
    const res = await fetch('/api/removed-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kaprukaUrl, name, category, partnerName, sourcePage, snapshot, reason, removedBy, matchScope }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to remove product');
    return data;
  }

  async function restore(id) {
    const res = await fetch(`/api/removed-products/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to restore product');
  }

  // Small centered modal asking who's removing the product and why. When
  // siblingCount > 0 — other currently-live items share this exact product
  // name + partner under a different Kapruka URL (clothing size/colour
  // variants are the common case: each is its own product page) — also offers
  // a checkbox to exclude all of them, not just this one exact URL. Off by
  // default, so a single click keeps doing the narrow, exact-URL-only thing
  // people expect; see the removed_products note in db.js. Resolves
  // { removedBy, reason, matchScope }, or null if the user cancelled.
  function promptRemoval(itemLabel, siblingCount = 0) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'rp-overlay';
      const siblingNote = siblingCount > 0
        ? `<label class="rp-sibling-check">
             <input type="checkbox" id="rpBroad" />
             Also remove ${siblingCount} other currently-listed size/variant${siblingCount === 1 ? '' : 's'}
             of this product from this store
           </label>
           <p class="rp-sibling-hint">Matches by exact product name + store — e.g. other sizes/colours of the
             same shirt listed under their own Kapruka URL.</p>`
        : '';
      overlay.innerHTML = `
        <div class="rp-modal">
          <h3>Remove product from dashboard</h3>
          <p class="rp-item">${escapeHtml(itemLabel)}</p>
          <label for="rpBy">Your name</label>
          <input id="rpBy" type="text" placeholder="Who's removing this?" autocomplete="off" />
          <label for="rpReason">Reason for removing this product</label>
          <textarea id="rpReason" placeholder="e.g. Partner price includes a free add-on that justifies the difference"></textarea>
          ${siblingNote}
          <div class="rp-actions">
            <button type="button" class="ghost" id="rpCancel">Cancel</button>
            <button type="button" id="rpConfirm">Remove product</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const close = (val) => { document.body.removeChild(overlay); resolve(val); };
      overlay.querySelector('#rpCancel').addEventListener('click', () => close(null));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
      overlay.querySelector('#rpConfirm').addEventListener('click', () => {
        const byEl = overlay.querySelector('#rpBy');
        const reasonEl = overlay.querySelector('#rpReason');
        const broadEl = overlay.querySelector('#rpBroad');
        const removedBy = byEl.value.trim();
        const reason = reasonEl.value.trim();
        if (!removedBy) { byEl.focus(); return; }
        if (!reason) { reasonEl.focus(); return; }
        close({ removedBy, reason, matchScope: broadEl && broadEl.checked ? 'name_partner' : 'url' });
      });
      overlay.querySelector('#rpBy').focus();
    });
  }

  // Shows the removal modal, then POSTs the removal if confirmed. Returns
  // true if the product was removed, false if the user cancelled. Pass
  // siblingCount (how many OTHER currently-live items share this item's
  // name+partner) so the modal can offer the broader removal and tell the
  // person how many other listings it would additionally exclude.
  async function removeWithPrompt(item, siblingCount = 0) {
    const result = await promptRemoval(item.name || item.kaprukaUrl, siblingCount);
    if (result == null) return false;
    await remove({ ...item, reason: result.reason, removedBy: result.removedBy, matchScope: result.matchScope });
    return true;
  }

  function rowHtml(r) {
    const s = r.snapshot || {};
    const pct = s.pct == null ? '' : `${s.pct > 0 ? '+' : ''}${s.pct.toFixed(1)}%`;
    const diff = s.diff == null ? '—' : `${s.diff > 0 ? '+' : ''}${lkr(s.diff)}`;
    return `<tr>
      <td>${escapeHtml(r.category)}</td>
      <td><span class="store-pill">${escapeHtml(r.partnerName)}</span></td>
      <td class="col-product">
        <div class="prod-name">${link(r.kaprukaUrl, r.name || r.kaprukaUrl)}${
          r.matchScope === 'name_partner'
            ? ' <span class="rp-scope-badge" title="Also excludes every other currently-listed size/variant of this product from this store">+ variants</span>'
            : ''
        }</div>
        <div class="prod-name prod-partner">${link(otherUrl(s), otherName(s) || '—')}</div>
      </td>
      <td class="num price">${lkr(s.kaprukaPrice)}</td>
      <td class="num">${lkr(otherPrice(s))}</td>
      <td class="num rp-over-amt">${diff}</td>
      <td class="num rp-over-amt">${pct}</td>
      <td class="num">${s.nameSimilarity != null ? s.nameSimilarity + '%' : '—'}</td>
      <td>${escapeHtml(r.removedBy)}</td>
      <td class="reason">${escapeHtml(r.reason)}</td>
      <td>${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</td>
      <td><button type="button" class="ghost rp-restore" data-id="${r.id}">↩ Restore</button></td>
    </tr>`;
  }

  // Renders the Removed Products table into containerEl; onRestore(count)
  // fires after load and after every successful restore, so the calling page
  // can refresh its own data/counts.
  // One <option> per distinct value of a column, sorted, for the filter dropdowns.
  // `caseInsensitive` folds spellings that differ only by case/spacing ("Iresha"
  // / "iresha" / "IRESHA" — people type their own name in the removal modal)
  // into one entry; the option's value is the lowercase key.
  function optionsHtml(label, values, caseInsensitive = false) {
    let opts;
    if (caseInsensitive) {
      const byKey = new Map();
      for (const v of values) {
        const key = norm(v);
        if (key && !byKey.has(key)) byKey.set(key, String(v).trim());
      }
      opts = [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1]))
        .map(([key, shown]) => `<option value="${escapeHtml(key)}">${escapeHtml(shown)}</option>`);
    } else {
      opts = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
        .map((v) => `<option>${escapeHtml(v)}</option>`);
    }
    return `<option value="">${label}</option>` + opts.join('');
  }
  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

  // Does a removed row pass the current filter values? The text box searches
  // every readable column — product names, store, who removed it, and the
  // reason — so "free add-on" finds the rows removed for that reason.
  function matchesFilters(r, f) {
    if (f.category && r.category !== f.category) return false;
    if (f.store && r.partnerName !== f.store) return false;
    if (f.by && norm(r.removedBy) !== f.by) return false;
    if (f.q) {
      const s = r.snapshot || {};
      const hay = [r.name, r.kaprukaUrl, r.category, r.partnerName, otherName(s), r.removedBy, r.reason]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(f.q)) return false;
    }
    return true;
  }

  // Sortable columns: header label, whether it's numeric (right-aligned, and
  // sorts biggest-first by default), and how to read the value off a row.
  const SORTS = [
    { key: 'category', label: 'Category', get: (r) => r.category },
    { key: 'store', label: 'Store', get: (r) => r.partnerName },
    { key: 'product', label: 'Product', get: (r) => r.name || r.kaprukaUrl },
    { key: 'kapruka', label: 'Kapruka', num: true, get: (r) => r.snapshot?.kaprukaPrice },
    { key: 'partner', label: 'Partner site', num: true, get: (r) => otherPrice(r.snapshot) },
    { key: 'diff', label: 'Overcharge', num: true, get: (r) => r.snapshot?.diff },
    { key: 'pct', label: '%', num: true, get: (r) => r.snapshot?.pct },
    { key: 'sim', label: 'Name Sim %', num: true, get: (r) => r.snapshot?.nameSimilarity },
    { key: 'by', label: 'Removed by', get: (r) => norm(r.removedBy) },
    { key: 'reason', label: 'Reason', get: (r) => norm(r.reason) },
    { key: 'createdAt', label: 'Removed at', num: true, get: (r) => (r.createdAt ? Date.parse(r.createdAt) : null) },
  ];

  // Rows with no value for the sorted column (e.g. a removal saved without a
  // price snapshot) always go to the bottom, whichever direction is chosen.
  function sortRows(rows, { key, dir }) {
    const col = SORTS.find((s) => s.key === key);
    const sign = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      const ea = va == null || va === '';
      const eb = vb == null || vb === '';
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
      return sign * (col.num ? va - vb : String(va).localeCompare(String(vb), undefined, { sensitivity: 'base' }));
    });
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Downloads exactly the rows currently shown (so a filtered view exports as
  // filtered), with the removal reason, who removed it and when. Built in the
  // browser from the same list the table uses, so the file always matches the
  // screen. BOM so Excel opens the UTF-8 correctly.
  function downloadCsv(rows) {
    const header = [
      'Category', 'Store', 'Kapruka product', 'Kapruka URL', 'Kapruka price (LKR)',
      'Partner product', 'Partner URL', 'Partner price (LKR)', 'Overcharge (LKR)', 'Overcharge %',
      'Name similarity %', 'Also removes variants', 'Removed by', 'Reason', 'Removed at',
    ];
    const lines = rows.map((r) => {
      const s = r.snapshot || {};
      return [
        r.category, r.partnerName, r.name, r.kaprukaUrl, s.kaprukaPrice,
        otherName(s), otherUrl(s), otherPrice(s), s.diff,
        s.pct == null ? '' : s.pct.toFixed(1), s.nameSimilarity,
        r.matchScope === 'name_partner' ? 'Yes' : 'No',
        r.removedBy, r.reason, r.createdAt ? new Date(r.createdAt).toISOString() : '',
      ].map(csvCell).join(',');
    });
    const csv = '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `removed-products-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function renderInto(containerEl, onRestore) {
    containerEl.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const rows = await list();
      if (!rows.length) {
        containerEl.innerHTML = '<p class="empty">No removed products yet.</p>';
        if (onRestore) onRestore(0);
        return;
      }
      containerEl.innerHTML = `
        <div class="rp-filters" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px">
          <input type="search" class="rp-f-q" placeholder="Filter by product, store, reason…" style="max-width:280px" />
          <select class="rp-f-category" style="max-width:200px">${optionsHtml('All categories', rows.map((r) => r.category))}</select>
          <select class="rp-f-store" style="max-width:200px">${optionsHtml('All stores', rows.map((r) => r.partnerName))}</select>
          <select class="rp-f-by" style="max-width:200px">${optionsHtml('Anyone', rows.map((r) => r.removedBy), true)}</select>
          <select class="rp-f-sort" style="max-width:220px" title="Sort the removed products">
            ${SORTS.map((s) => `<option value="${s.key}">Sort: ${s.label}</option>`).join('')}
          </select>
          <button type="button" class="ghost rp-f-dir" title="Reverse the sort order"></button>
          <span class="rp-f-count" style="font-size:12px;color:var(--mut)"></span>
          <button type="button" class="ghost rp-export" style="margin-left:auto">⬇ Export removed (CSV)</button>
        </div>
        <div class="table-wrap"><table><thead><tr>
          ${SORTS.map((s) => `<th class="${s.num ? 'num ' : ''}rp-sortable" data-sort="${s.key}" style="cursor:pointer;user-select:none;white-space:nowrap">${s.label}<span class="rp-arrow"></span></th>`).join('')}<th></th>
        </tr></thead><tbody></tbody></table></div>`;

      const $$ = (sel) => containerEl.querySelector(sel);
      const tbody = $$('tbody');
      let visible = rows;
      // Newest removal first — the order the list has always been shown in.
      let sort = { key: 'createdAt', dir: 'desc' };
      const apply = () => {
        const f = {
          q: $$('.rp-f-q').value.trim().toLowerCase(),
          category: $$('.rp-f-category').value,
          store: $$('.rp-f-store').value,
          by: $$('.rp-f-by').value,
        };
        visible = sortRows(rows.filter((r) => matchesFilters(r, f)), sort);
        $$('.rp-f-sort').value = sort.key;
        $$('.rp-f-dir').textContent = sort.dir === 'asc' ? '▲ Ascending' : '▼ Descending';
        containerEl.querySelectorAll('.rp-sortable').forEach((th) => {
          th.querySelector('.rp-arrow').textContent = th.dataset.sort === sort.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
        });
        tbody.innerHTML = visible.length
          ? visible.map(rowHtml).join('')
          : '<tr><td colspan="12" class="empty">No removed products match this filter.</td></tr>';
        $$('.rp-f-count').textContent = `Showing ${visible.length} of ${rows.length}`;
      };
      ['.rp-f-q', '.rp-f-category', '.rp-f-store', '.rp-f-by'].forEach((sel) =>
        $$(sel).addEventListener(sel === '.rp-f-q' ? 'input' : 'change', apply),
      );
      // Same key again flips the direction; a new key starts at its natural
      // direction (text A→Z, numbers and dates biggest/newest first).
      const setSort = (key) => {
        sort = key === sort.key
          ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: SORTS.find((s) => s.key === key).num || key === 'createdAt' ? 'desc' : 'asc' };
        apply();
      };
      $$('.rp-f-sort').addEventListener('change', (e) => { sort = { key: e.target.value, dir: SORTS.find((s) => s.key === e.target.value).num || e.target.value === 'createdAt' ? 'desc' : 'asc' }; apply(); });
      $$('.rp-f-dir').addEventListener('click', () => { sort = { ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' }; apply(); });
      containerEl.querySelectorAll('.rp-sortable').forEach((th) => th.addEventListener('click', () => setSort(th.dataset.sort)));
      $$('.rp-export').addEventListener('click', () => downloadCsv(visible));
      apply();

      // Delegated so the buttons keep working after the filter rebuilds the rows.
      tbody.addEventListener('click', async (e) => {
        const btn = e.target.closest('.rp-restore');
        if (!btn) return;
        btn.disabled = true;
        try {
          await restore(Number(btn.dataset.id));
          await renderInto(containerEl, onRestore);
        } catch (err) {
          alert('Error: ' + err.message);
          btn.disabled = false;
        }
      });
      if (onRestore) onRestore(rows.length);
    } catch (err) {
      containerEl.innerHTML = `<p class="empty">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  async function count() {
    try {
      const rows = await list();
      return rows.length;
    } catch {
      return 0;
    }
  }

  return { list, remove, restore, removeWithPrompt, renderInto, count };
})();
