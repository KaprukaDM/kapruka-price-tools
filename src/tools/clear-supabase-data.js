// Standalone tool: wipes all rows from the two Supabase tables this project
// uses (comparison_runs, price_checks), so the Overpriced dashboard and Price
// Checker history start fresh. Uses the PostgREST REST API directly (no
// TRUNCATE support there), so it needs a filter that matches every row —
// `id=gte.0` does that for the bigserial id columns both tables use.
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in .env (same vars src/db.js
// uses). Run from a machine that can actually reach *.supabase.co.
//
// Usage:
//   node src/tools/clear-supabase-data.js

import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('! SUPABASE_URL and/or SUPABASE_SERVICE_KEY are not set in .env');
  process.exit(1);
}

const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const headers = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function clearTable(table) {
  const res = await fetch(`${REST}/${table}?id=gte.0`, { method: 'DELETE', headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase REST ${res.status} on ${table}: ${text}`);
  }
  const rows = await res.json().catch(() => []);
  console.log(`✓ ${table}: deleted ${rows.length} row(s)`);
}

for (const table of ['comparison_runs', 'price_checks']) {
  await clearTable(table);
}
console.log('Done — both tables are empty.');
