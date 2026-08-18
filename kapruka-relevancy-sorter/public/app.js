const form = document.getElementById('loadForm');
const urlInput = document.getElementById('urlInput');
const loadBtn = document.getElementById('loadBtn');
const sortBtn = document.getElementById('sortBtn');
const statusEl = document.getElementById('status');
const grid = document.getElementById('grid');

let state = { term: null, sourceUrl: null, products: [] };

function setStatus(msg) {
  statusEl.textContent = msg || '';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatPrice(p) {
  if (p.price == null) return '';
  const value = Number(p.price).toLocaleString();
  return `${p.currency || ''} ${value}`.trim();
}

function render(products, { sorted } = {}) {
  grid.innerHTML = products.map((p, i) => `
    <div class="card">
      <span class="rank">#${i + 1}</span>
      ${sorted ? `<span class="score">${p.relevancyScore}</span>` : ''}
      <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">
        <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.title)}" loading="lazy" />
      </a>
      <div class="body">
        <a class="title" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.title)}</a>
        <div class="price">${escapeHtml(formatPrice(p))}</div>
        ${sorted ? `<div class="reason">${escapeHtml(p.reasoning)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  loadBtn.disabled = true;
  sortBtn.disabled = true;
  setStatus('Loading listing...');
  grid.innerHTML = '';

  try {
    const res = await fetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load listing');

    state = { term: data.term, sourceUrl: data.sourceUrl, products: data.products };
    render(state.products, { sorted: false });
    setStatus(`Loaded ${state.products.length} products for "${state.term}"`);
    sortBtn.disabled = state.products.length === 0;
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    loadBtn.disabled = false;
  }
});

sortBtn.addEventListener('click', async () => {
  if (!state.products.length) return;

  sortBtn.disabled = true;
  loadBtn.disabled = true;
  setStatus('Asking AI to score relevancy (looking at photos + titles)...');

  try {
    const res = await fetch('/api/sort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: state.term, products: state.products }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to sort');

    state.products = data.products;
    render(state.products, { sorted: true });
    setStatus(`Sorted ${state.products.length} products by relevancy to "${state.term}"`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    sortBtn.disabled = false;
    loadBtn.disabled = false;
  }
});
