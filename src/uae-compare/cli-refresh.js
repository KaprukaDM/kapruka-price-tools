// CLI entry point for the GitHub Actions refresh workflow
// (.github/workflows/uae-compare-refresh.yml) — re-scrapes, recomputes, and
// saves the latest snapshot for a country. The static dashboard
// (public/uae-compare/index.html) reads whatever this last wrote.
//
// Usage: node src/uae-compare/cli-refresh.js [COUNTRY]   (default: UAE)
// Needs SUPABASE_URL + SUPABASE_SERVICE_KEY (or DATABASE_URL) in the
// environment — set as GitHub Actions repo secrets.

import 'dotenv/config';
import { runComparison } from './engine.js';

const country = process.argv[2] || process.env.INTL_GIFT_COUNTRY || 'UAE';

try {
  const result = await runComparison(country, { forceFx: true });
  console.log(
    `[${country}] ${result.kaprukaCount} products, ${result.pairedCount} paired, ` +
      `1 AED = ${result.fx.aedToLkr.toFixed(2)} LKR — snapshot saved.`,
  );
} catch (err) {
  console.error(`Refresh failed for ${country}:`, err.message);
  process.exit(1);
}
