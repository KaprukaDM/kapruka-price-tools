// CLI entry point for the GitHub Actions pairing-edit workflow
// (.github/workflows/uae-compare-set-pairing.yml) — the static dashboard's
// "Save" button has no server to POST to, so it triggers this workflow with
// inputs instead. Sets one pairing, then re-runs the comparison so the
// snapshot the dashboard reads reflects the edit immediately.
//
// Usage: node src/uae-compare/cli-set-pairing.js <COUNTRY> <SKU> <FNP_URL|-->
//   Pass "--" (or omit) as FNP_URL to clear an existing pairing.
// Needs SUPABASE_URL + SUPABASE_SERVICE_KEY (or DATABASE_URL) in the
// environment — set as GitHub Actions repo secrets.

import 'dotenv/config';
import { setPairing } from './pairings-store.js';
import { getCountry } from './countries.js';
import { runComparison } from './engine.js';

const [country, sku, rawUrl] = process.argv.slice(2);
const fnpUrl = !rawUrl || rawUrl === '--' ? null : rawUrl;

if (!country || !sku) {
  console.error('Usage: node src/uae-compare/cli-set-pairing.js <COUNTRY> <SKU> <FNP_URL|-->');
  process.exit(1);
}

try {
  const countryDef = getCountry(country);
  if (fnpUrl && !countryDef.competitorUrlPattern.test(fnpUrl)) {
    throw new Error(`fnpUrl must be a ${countryDef.competitorName} product link`);
  }

  await setPairing(country, sku, fnpUrl, 'manual', null);
  console.log(fnpUrl ? `[${country}] ${sku} -> ${fnpUrl}` : `[${country}] ${sku} pairing cleared`);

  const result = await runComparison(country, { forceFx: true });
  console.log(`[${country}] snapshot refreshed — ${result.pairedCount}/${result.kaprukaCount} paired.`);
} catch (err) {
  console.error('Set pairing failed:', err.message);
  process.exit(1);
}
