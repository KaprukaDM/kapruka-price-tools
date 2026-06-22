// Turn a matchCatalogs() result into files on disk:
//   matched.csv         - products on both sites, with price comparison
//   only_on_kapruka.csv - on our Kapruka page, not on the partner site
//   only_on_partner.csv - on the partner site, not on our Kapruka page
//   report.html         - human-friendly dashboard of all of the above

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { summarize } from './matcher.js';

const lkr = (v) => (v == null ? '' : `Rs.${Number(v).toLocaleString('en-LK')}`);

function csv(rows, headers) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map((h) => h.label).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(h.get(r))).join(','));
  return lines.join('\n');
}

const VERDICT_LABEL = {
  same: 'Same price',
  kapruka_higher: 'Kapruka OVERPRICED',
  kapruka_lower: 'Kapruka cheaper',
  price_missing: 'Price missing',
};

function htmlEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function matchedTable(matched) {
  const order = { kapruka_higher: 0, price_missing: 1, kapruka_lower: 2, same: 3 };
  const rows = [...matched].sort(
    (a, b) => (order[a.verdict] - order[b.verdict]) || (Math.abs(b.diff || 0) - Math.abs(a.diff || 0)),
  );
  return rows
    .map((m) => {
      const cls = m.verdict === 'kapruka_higher' ? 'over' : m.verdict === 'kapruka_lower' ? 'under' : m.verdict === 'same' ? 'same' : 'missing';
      const pct = m.pct == null ? '' : `${m.pct > 0 ? '+' : ''}${m.pct.toFixed(1)}%`;
      return `<tr class="${cls}">
        <td><a href="${htmlEscape(m.kaprukaUrl)}" target="_blank">${htmlEscape(m.name)}</a>
            <div class="sub">matched: <a href="${htmlEscape(m.partnerUrl)}" target="_blank">${htmlEscape(m.partnerName)}</a>
            · ${m.confidence} confidence · name sim ${m.nameSimilarity}%</div></td>
        <td class="num">${lkr(m.kaprukaPrice)}</td>
        <td class="num">${lkr(m.partnerPrice)}</td>
        <td class="num">${m.diff == null ? '' : lkr(m.diff)}</td>
        <td class="num">${pct}</td>
        <td>${VERDICT_LABEL[m.verdict]}</td>
      </tr>`;
    })
    .join('\n');
}

function listTable(rows, withSku) {
  return rows
    .map(
      (r) => `<tr>
        <td><a href="${htmlEscape(r.url)}" target="_blank">${htmlEscape(r.name)}</a>${
        withSku && r.sku ? `<div class="sub">SKU: ${htmlEscape(r.sku)}</div>` : ''
      }</td>
        <td class="num">${lkr(r.price)}</td>
      </tr>`,
    )
    .join('\n');
}

function buildHtml(result, s, generatedAt, partner) {
  const pLabel = htmlEscape(partner.partnerLabel || partner.partnerSite || 'partner site');
  const pName = htmlEscape(partner.name || 'Partner');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kapruka × ${pName} — Price Reconciliation</title>
<style>
  :root { font-family: system-ui, Arial, sans-serif; }
  body { margin: 0; background: #f6f7f9; color: #1c2330; }
  header { background: #402970; color: #fff; padding: 20px 28px; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; opacity: .8; font-size: 13px; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; padding: 20px 28px; }
  .card { background: #fff; border-radius: 10px; padding: 14px 18px; min-width: 130px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card .n { font-size: 26px; font-weight: 700; }
  .card .l { font-size: 12px; color: #5b6573; text-transform: uppercase; letter-spacing: .04em; }
  .card.bad .n { color: #c0392b; }
  .card.good .n { color: #1e8449; }
  section { padding: 0 28px 28px; }
  h2 { font-size: 16px; border-bottom: 2px solid #e1e5ea; padding-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef1f4; vertical-align: top; }
  th { background: #f0f2f5; position: sticky; top: 0; font-size: 12px; }
  td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .sub { font-size: 11px; color: #7a8290; margin-top: 2px; }
  a { color: #1d6fb8; text-decoration: none; } a:hover { text-decoration: underline; }
  tr.over td { background: #fdecea; } tr.over td:first-child { box-shadow: inset 3px 0 #c0392b; }
  tr.under td { background: #eafaf1; }
  tr.missing td { background: #fef9e7; }
  details { background:#fff; border-radius:8px; margin-bottom:18px; }
  summary { cursor:pointer; padding:12px 14px; font-weight:600; }
</style></head>
<body>
<header>
  <h1>Kapruka × ${pName} — Price Reconciliation</h1>
  <p>Our listing: ${htmlEscape((partner.kaprukaLink || '').replace(/^https?:\/\//, ''))} &nbsp;·&nbsp; Partner site: ${pLabel} &nbsp;·&nbsp; Generated ${htmlEscape(generatedAt)}</p>
</header>
<div class="cards">
  <div class="card"><div class="n">${s.matched}</div><div class="l">Matched (both)</div></div>
  <div class="card bad"><div class="n">${s.kaprukaHigher}</div><div class="l">Kapruka overpriced</div></div>
  <div class="card good"><div class="n">${s.kaprukaLower}</div><div class="l">Kapruka cheaper</div></div>
  <div class="card"><div class="n">${s.same}</div><div class="l">Same price</div></div>
  <div class="card"><div class="n">${s.onlyKapruka}</div><div class="l">Only on Kapruka</div></div>
  <div class="card"><div class="n">${s.onlyPartner}</div><div class="l">Only on ${pName}</div></div>
</div>

<section>
  <h2>Matched products — price comparison (${result.matched.length})</h2>
  <table>
    <thead><tr><th>Product</th><th class="num">Kapruka</th><th class="num">${pLabel}</th><th class="num">Diff</th><th class="num">%</th><th>Verdict</th></tr></thead>
    <tbody>${matchedTable(result.matched)}</tbody>
  </table>
</section>

<section>
  <details><summary>Only on Kapruka — listed by us, not found on ${pLabel} (${result.onlyKapruka.length})</summary>
  <table><thead><tr><th>Product</th><th class="num">Kapruka price</th></tr></thead>
  <tbody>${listTable(result.onlyKapruka, false)}</tbody></table></details>

  <details><summary>Only on ${pLabel} — on their site, not listed by us (${result.onlyPartner.length})</summary>
  <table><thead><tr><th>Product</th><th class="num">Partner price</th></tr></thead>
  <tbody>${listTable(result.onlyPartner, true)}</tbody></table></details>
</section>
</body></html>`;
}

export async function writeReports(result, outDir, { generatedAt, partner }) {
  await mkdir(outDir, { recursive: true });
  const s = summarize(result);

  await writeFile(
    join(outDir, 'matched.csv'),
    csv(result.matched, [
      { label: 'product', get: (r) => r.name },
      { label: 'kapruka_price', get: (r) => r.kaprukaPrice },
      { label: 'partner_price', get: (r) => r.partnerPrice },
      { label: 'diff_kapruka_minus_partner', get: (r) => r.diff },
      { label: 'pct', get: (r) => (r.pct == null ? '' : r.pct.toFixed(1)) },
      { label: 'verdict', get: (r) => r.verdict },
      { label: 'confidence', get: (r) => r.confidence },
      { label: 'name_similarity_pct', get: (r) => r.nameSimilarity },
      { label: 'partner_matched_name', get: (r) => r.partnerName },
      { label: 'kapruka_url', get: (r) => r.kaprukaUrl },
      { label: 'partner_url', get: (r) => r.partnerUrl },
    ]),
  );
  await writeFile(
    join(outDir, 'only_on_kapruka.csv'),
    csv(result.onlyKapruka, [
      { label: 'product', get: (r) => r.name },
      { label: 'kapruka_price', get: (r) => r.price },
      { label: 'kapruka_url', get: (r) => r.url },
    ]),
  );
  await writeFile(
    join(outDir, 'only_on_partner.csv'),
    csv(result.onlyPartner, [
      { label: 'product', get: (r) => r.name },
      { label: 'sku', get: (r) => r.sku },
      { label: 'partner_price', get: (r) => r.price },
      { label: 'partner_url', get: (r) => r.url },
    ]),
  );
  await writeFile(join(outDir, 'report.html'), buildHtml(result, s, generatedAt, partner));
  return s;
}
