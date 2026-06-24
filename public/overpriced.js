const $ = (id) => document.getElementById(id);
let DATA = null;

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
  const stores = d.partners.filter((p) => p.overpriced > 0).length;
  $('cards').innerHTML =
    card(d.count, 'Overpriced products', 'bad') +
    card(stores + ' / ' + d.partners.length, 'Stores affected') +
    card(lkr(Math.round(d.totalOvercharge)), 'Total overcharge', 'bad');
}

function storeOptions(d) {
  const sel = $('store');
  const current = sel.value;
  sel.innerHTML = '<option value="">All stores</option>' +
    d.partners
      .filter((p) => p.overpriced > 0)
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} · ${p.overpriced}</option>`)
      .join('');
  sel.value = current;
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const store = $('store').value;
  const rows = DATA.items.filter(
    (m) => (!store || m.partnerId === store) && (!q || m.name.toLowerCase().includes(q)),
  );

  if (!rows.length) {
    $('table').innerHTML = '<p class="empty">No overpriced products match your filter. 🎉</p>';
    return;
  }

  const body = rows
    .map((m) => {
      const pct = m.pct == null ? '' : `+${m.pct.toFixed(1)}%`;
      const conf = m.confidence === 'high'
        ? '<span class="badge b-hi">high</span>'
        : '<span class="badge b-md">review</span>';
      return `<tr class="over">
        <td><span class="store-pill">${escapeHtml(m.partner)}</span></td>
        <td>${link(m.kaprukaUrl, m.name)}
          <div class="ctx">matched: ${link(m.partnerUrl, m.partnerLabel)} · ${conf} · name sim ${m.nameSimilarity ?? '—'}%</div></td>
        <td class="num price">${lkr(m.kaprukaPrice)}</td>
        <td class="num">${lkr(m.partnerPrice)}</td>
        <td class="num over-amt">+${lkr(m.diff)}</td>
        <td class="num over-amt">${pct}</td>
      </tr>`;
    })
    .join('');

  $('table').innerHTML = `<table><thead><tr>
      <th>Store</th><th>Product</th>
      <th class="num">Kapruka</th><th class="num">Partner site</th>
      <th class="num">Overcharge</th><th class="num">%</th></tr></thead>
    <tbody>${body}</tbody></table>`;
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
  storeOptions(DATA);
  render();
  footmeta();
  $('status').style.display = 'none';
  $('app').style.display = '';
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
  } catch (err) {
    alert('Refresh failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

$('search').addEventListener('input', render);
$('store').addEventListener('change', render);
$('refresh').addEventListener('click', refreshNow);

load();
