const $ = (id) => document.getElementById(id);
let ALL = []; // every site, all statuses -- filtered client-side per tab
let STATUS = 'pending';
// Per-domain catalogue stats + live crawl state from
// /api/discovered-sites/crawl-status. Loaded after the table so the list
// paints immediately, then polled while any crawl is running.
let CRAWL = { sites: {}, running: {}, trustedScrapeHost: false, loaded: false };
let POLL_TIMER = null;

// 'queued'      -- approved here, but this host isn't the trusted-geo scraper,
//                  so the crawl was deferred to the scheduled job.
// 'unsupported' -- crawled, but no adapter could read a catalogue from the site.
const TABS = ['pending', 'queued', 'approved', 'unsupported', 'rejected'];

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}
function link(url, text) {
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>` : escapeHtml(text || '—');
}

function statCards() {
  const counts = {};
  for (const s of ALL) counts[s.status] = (counts[s.status] || 0) + 1;
  const card = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  // "Approved but empty" is the whole point of this page's new column: an
  // approved site with no catalogue rows contributes nothing to the Price
  // Checker, so it gets its own headline number rather than hiding in a table.
  const emptyApproved = ALL.filter(
    (s) => s.status === 'approved' && CRAWL.loaded && !(CRAWL.sites[s.domain]?.products > 0),
  ).length;
  $('cards').innerHTML =
    card(counts.pending || 0, 'Pending review') +
    card(counts.queued || 0, 'Queued to crawl') +
    card(counts.approved || 0, 'Approved') +
    card(CRAWL.loaded ? emptyApproved : '…', 'Approved, no catalogue') +
    card(counts.unsupported || 0, 'Unsupported platform') +
    card(counts.rejected || 0, 'Rejected');
}

function hostNote() {
  if (!CRAWL.loaded || CRAWL.trustedScrapeHost) {
    $('hostNote').innerHTML = '';
    return;
  }
  $('hostNote').innerHTML =
    `<div class="card" style="margin-bottom:14px"><b>Approvals here are queued, not crawled.</b>
     This instance isn't the trusted Sri-Lanka-geo scraper (<code>SCRAPE_ON_ADD</code> unset), so approving a site
     marks it <b>Queued</b> and the scheduled <code>crawl-discovered-sites.js</code> run on the good-geo host
     crawls it into the database.</div>`;
}

function setTab(status) {
  STATUS = status;
  TABS.forEach((s) => {
    $('tab' + s[0].toUpperCase() + s.slice(1)).classList.toggle('active', s === status);
  });
  render();
}

function crawlCell(site) {
  const live = CRAWL.running[site.id];
  if (live && live.state === 'running') {
    const mins = Math.round(live.elapsedMs / 60000);
    const last = (live.lines || []).slice(-1)[0] || '';
    return `<div class="crawl run"><span class="spin"></span><b>Crawling…</b>
      <span class="when">${mins} min${mins === 1 ? '' : 's'} so far${last ? ' · ' + escapeHtml(last.trim().slice(0, 60)) : ''}</span></div>`;
  }
  if (live && live.state === 'failed') {
    return `<div class="crawl none"><b>Crawl failed</b><span class="when">${escapeHtml((live.note || '').slice(0, 70))}</span></div>`;
  }
  if (!CRAWL.loaded) return '<span class="ctx">…</span>';
  const stats = CRAWL.sites[site.domain];
  if (!stats || !stats.products) {
    if (site.status === 'queued') return '<div class="crawl run"><b>Queued</b><span class="when">waiting for the scraper host</span></div>';
    if (site.status === 'unsupported') return '<div class="crawl none"><b>No catalogue</b><span class="when">no adapter reads this platform</span></div>';
    if (site.status === 'approved') return '<div class="crawl none"><b>0 products</b><span class="when">approved but never crawled</span></div>';
    return '<span class="ctx">—</span>';
  }
  const when = stats.lastScrapedAt ? new Date(stats.lastScrapedAt).toLocaleDateString() : '';
  return `<div class="crawl ok"><b>${stats.products.toLocaleString()} products</b>
    <span class="when">${when ? 'scraped ' + escapeHtml(when) : ''}</span></div>`;
}

function render() {
  const rows = ALL.filter((s) => s.status === STATUS);
  if (!rows.length) {
    $('table').innerHTML = `<p class="empty">No ${STATUS} sites.</p>`;
    return;
  }
  const body = rows
    .map((s) => {
      const busy = CRAWL.running[s.id]?.state === 'running';
      const actions = STATUS === 'pending'
        ? `<div class="row-actions">
             <input type="text" class="cat-input" data-id="${s.id}" placeholder="Category (e.g. Other)" value="${escapeHtml(s.category || '')}" />
             <button type="button" class="ghost btn-approve" data-id="${s.id}">✓ Approve &amp; crawl</button>
             <button type="button" class="ghost btn-reject" data-id="${s.id}">✕ Reject</button>
           </div>`
        : STATUS === 'rejected'
          ? `<span class="ctx">${s.status}</span>`
          : `<div class="row-actions">
               <button type="button" class="ghost btn-crawl" data-id="${s.id}"${busy ? ' disabled' : ''}>
                 ${busy ? 'Crawling…' : '↻ Crawl now'}</button>
             </div>`;
      return `<tr>
        <td class="domain">${escapeHtml(s.domain)}</td>
        <td>${escapeHtml(s.category || '—')}</td>
        <td class="num">${s.timesSeen}</td>
        <td>${crawlCell(s)}</td>
        <td>${link(s.sampleUrl, 'sample listing')}<div class="ctx">"${escapeHtml(s.sampleQuery)}"</div></td>
        <td>${new Date(s.lastSeen).toLocaleDateString()}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('');
  $('table').innerHTML = `<div class="table-wrap"><table><thead><tr>
      <th>Domain</th><th>Category</th><th>Times seen</th><th>Catalogue</th><th>Sample</th><th>Last seen</th><th>Action</th>
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
        loadCrawlStatus();
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
      }
    });
  });
  $('table').querySelectorAll('.btn-crawl').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      try {
        const res = await fetch(`/api/discovered-sites/${btn.dataset.id}/crawl`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'crawl failed');
        await load();
        loadCrawlStatus();
      } catch (err) {
        alert('Error: ' + err.message);
        btn.disabled = false;
        btn.textContent = '↻ Crawl now';
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

async function loadCrawlStatus() {
  try {
    const res = await fetch('/api/discovered-sites/crawl-status');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'request failed');
    CRAWL = {
      sites: Object.fromEntries(data.sites.map((s) => [s.domain, s])),
      running: data.running || {},
      trustedScrapeHost: !!data.trustedScrapeHost,
      loaded: true,
    };
    hostNote();
    statCards();
    render();
  } catch {
    // Non-fatal: the table still works, the Catalogue column just stays blank.
  }
  // Keep polling only while something is actually crawling.
  clearTimeout(POLL_TIMER);
  if (Object.values(CRAWL.running).some((r) => r.state === 'running')) {
    POLL_TIMER = setTimeout(loadCrawlStatus, 10000);
  }
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

TABS.forEach((s) => {
  $('tab' + s[0].toUpperCase() + s.slice(1)).addEventListener('click', () => setTab(s));
});
setTab('pending');
load().then(loadCrawlStatus);
