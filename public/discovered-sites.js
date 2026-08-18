const $ = (id) => document.getElementById(id);
let ALL = []; // every site, all statuses -- filtered client-side per tab
let STATUS = 'pending';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
function link(url, text) {
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>` : escapeHtml(text || '—');
}

function statCards() {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  for (const s of ALL) counts[s.status] = (counts[s.status] || 0) + 1;
  const card = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  $('cards').innerHTML =
    card(counts.pending, 'Pending review') +
    card(counts.approved, 'Approved') +
    card(counts.rejected, 'Rejected');
}

function setTab(status) {
  STATUS = status;
  ['pending', 'approved', 'rejected'].forEach((s) => {
    $('tab' + s[0].toUpperCase() + s.slice(1)).classList.toggle('active', s === status);
  });
  render();
}

function render() {
  const rows = ALL.filter((s) => s.status === STATUS);
  if (!rows.length) {
    $('table').innerHTML = `<p class="empty">No ${STATUS} sites.</p>`;
    return;
  }
  const body = rows
    .map((s) => {
      const actions = STATUS === 'pending'
        ? `<div class="row-actions">
             <input type="text" class="cat-input" data-id="${s.id}" placeholder="Category (e.g. Other)" value="${escapeHtml(s.category || '')}" />
             <button type="button" class="ghost btn-approve" data-id="${s.id}">✓ Approve</button>
             <button type="button" class="ghost btn-reject" data-id="${s.id}">✕ Reject</button>
           </div>`
        : `<span class="ctx">${s.status}</span>`;
      return `<tr>
        <td class="domain">${escapeHtml(s.domain)}</td>
        <td>${escapeHtml(s.category || '—')}</td>
        <td class="num">${s.timesSeen}</td>
        <td>${link(s.sampleUrl, 'sample listing')}<div class="ctx">"${escapeHtml(s.sampleQuery)}"</div></td>
        <td>${new Date(s.lastSeen).toLocaleDateString()}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('');
  $('table').innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Domain</th><th>Category</th><th>Times seen</th><th>Sample</th><th>Last seen</th><th>Action</th>
    </tr></thead><tbody>${body}</tbody></table></div>`;
  wireActions();
}

function wireActions() {
  $('table').querySelectorAll('.btn-approve').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = $('table').querySelector(`.cat-input[data-id="${id}"]`);
      const category = (input.value || '').trim();
      if (!category) {
        alert('Enter a category first (e.g. "Other" if unsure).');
        input.focus();
        return;
      }
      btn.disabled = true;
      try {
        const res = await fetch(`/api/discovered-sites/${id}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'approve failed');
        await load();
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
      }
    });
  });
  $('table').querySelectorAll('.btn-reject').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/discovered-sites/${btn.dataset.id}/reject`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json()).error || 'reject failed');
        await load();
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

async function load() {
  try {
    const res = await fetch('/api/discovered-sites');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    ALL = data;
    statCards();
    render();
    $('status').style.display = 'none';
    $('app').style.display = '';
  } catch (err) {
    $('status').innerHTML = `Error: ${escapeHtml(err.message)} <button class="ghost" onclick="location.reload()">Retry</button>`;
  }
}

$('tabPending').addEventListener('click', () => setTab('pending'));
$('tabApproved').addEventListener('click', () => setTab('approved'));
$('tabRejected').addEventListener('click', () => setTab('rejected'));
setTab('pending');
load();
