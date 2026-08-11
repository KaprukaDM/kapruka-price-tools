// Shared "Removed Products" module used by compare.js, partner-overpriced.js
// and all-products-overpriced.js. A product removed from any one of those
// dashboards is stored server-side (keyed by its Kapruka URL — see
// /api/removed-products in src/server.js) and filtered out of every
// dashboard's reports, so this same module renders the shared card view on
// all three pages and lets the team restore an item from any of them.
const RemovedProducts = (function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }
  const lkr = (v) => (v == null ? null : 'Rs.' + Number(v).toLocaleString('en-LK'));

  async function list() {
    const res = await fetch('/api/removed-products');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load removed products');
    return data;
  }

  async function remove({ kaprukaUrl, name, category, partnerName, sourcePage, snapshot, reason }) {
    const res = await fetch('/api/removed-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kaprukaUrl, name, category, partnerName, sourcePage, snapshot, reason }),
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

  // Small centered modal asking for a removal reason. Resolves the trimmed
  // reason string, or null if the user cancelled.
  function promptReason(itemLabel) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'rp-overlay';
      overlay.innerHTML = `
        <div class="rp-modal">
          <h3>Remove product from dashboard</h3>
          <p class="rp-item">${escapeHtml(itemLabel)}</p>
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
        const ta = overlay.querySelector('#rpReason');
        const reason = ta.value.trim();
        if (!reason) { ta.focus(); return; }
        close(reason);
      });
      overlay.querySelector('#rpReason').focus();
    });
  }

  // Shows the reason modal, then POSTs the removal if confirmed. Returns true
  // if the product was removed, false if the user cancelled.
  async function removeWithPrompt(item) {
    const reason = await promptReason(item.name || item.kaprukaUrl);
    if (reason == null) return false;
    await remove({ ...item, reason });
    return true;
  }

  function priceLine(s) {
    if (!s || s.kaprukaPrice == null) return '';
    const k = lkr(s.kaprukaPrice);
    const other = lkr(s.partnerPrice != null ? s.partnerPrice : s.bestPrice);
    return other ? `Kapruka ${k} vs ${other}` : `Kapruka ${k}`;
  }

  function cardHtml(r) {
    const pl = priceLine(r.snapshot);
    return `<div class="rp-card">
      <div class="rp-card-head">
        <span class="rp-src">${escapeHtml(r.sourcePage || '')}</span>
        <button type="button" class="ghost rp-restore" data-id="${r.id}">↩ Restore</button>
      </div>
      <div class="rp-name">${escapeHtml(r.name || r.kaprukaUrl)}</div>
      <div class="rp-meta">${[r.category, r.partnerName].filter(Boolean).map(escapeHtml).join(' · ')}</div>
      ${pl ? `<div class="rp-meta">${escapeHtml(pl)}</div>` : ''}
      <div class="rp-reason">&ldquo;${escapeHtml(r.reason)}&rdquo;</div>
      <div class="rp-date">${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</div>
    </div>`;
  }

  // Renders the card grid into containerEl; onRestore(count) fires after a
  // successful restore so the calling page can refresh its own data/counts.
  async function renderInto(containerEl, onRestore) {
    containerEl.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const rows = await list();
      if (!rows.length) {
        containerEl.innerHTML = '<p class="empty">No removed products yet.</p>';
        if (onRestore) onRestore(0);
        return;
      }
      containerEl.innerHTML = `<div class="rp-grid">${rows.map(cardHtml).join('')}</div>`;
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
