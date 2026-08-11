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

  async function remove({ kaprukaUrl, name, category, partnerName, sourcePage, snapshot, reason, removedBy }) {
    const res = await fetch('/api/removed-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kaprukaUrl, name, category, partnerName, sourcePage, snapshot, reason, removedBy }),
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

  // Small centered modal asking who's removing the product and why. Resolves
  // { removedBy, reason }, or null if the user cancelled.
  function promptRemoval(itemLabel) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'rp-overlay';
      overlay.innerHTML = `
        <div class="rp-modal">
          <h3>Remove product from dashboard</h3>
          <p class="rp-item">${escapeHtml(itemLabel)}</p>
          <label for="rpBy">Your name</label>
          <input id="rpBy" type="text" placeholder="Who's removing this?" autocomplete="off" />
          <label for="rpReason">Reason for removing this product</label>
          <textarea id="rpReason" placeholder="e.g. Partner price includes a free add-on that justifies the difference"></textarea>
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
        const removedBy = byEl.value.trim();
        const reason = reasonEl.value.trim();
        if (!removedBy) { byEl.focus(); return; }
        if (!reason) { reasonEl.focus(); return; }
        close({ removedBy, reason });
      });
      overlay.querySelector('#rpBy').focus();
    });
  }

  // Shows the removal modal, then POSTs the removal if confirmed. Returns
  // true if the product was removed, false if the user cancelled.
  async function removeWithPrompt(item) {
    const result = await promptRemoval(item.name || item.kaprukaUrl);
    if (result == null) return false;
    await remove({ ...item, reason: result.reason, removedBy: result.removedBy });
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
        <div class="prod-name">${link(r.kaprukaUrl, r.name || r.kaprukaUrl)}</div>
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
  async function renderInto(containerEl, onRestore) {
    containerEl.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const rows = await list();
      if (!rows.length) {
        containerEl.innerHTML = '<p class="empty">No removed products yet.</p>';
        if (onRestore) onRestore(0);
        return;
      }
      containerEl.innerHTML = `<div class="table-wrap"><table><thead><tr>
          <th>Category</th><th>Store</th><th>Product</th><th class="num">Kapruka</th>
          <th class="num">Partner site</th><th class="num">Overcharge</th><th class="num">%</th>
          <th class="num">Name Sim %</th><th>Removed by</th><th>Reason</th><th>Removed at</th><th></th>
        </tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table></div>`;
      containerEl.querySelectorAll('.rp-restore').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await restore(Number(btn.dataset.id));
            await renderInto(containerEl, onRestore);
          } catch (err) {
            alert('Error: ' + err.message);
            btn.disabled = false;
          }
        });
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
