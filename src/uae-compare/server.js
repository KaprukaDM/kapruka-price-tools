// Standalone entry point for the FNP.ae vs Kapruka UAE price dashboard — runs
// it as its own service on its own port. The same routes are also embedded
// directly into the main Price Tools hub (src/server.js) at /uae-compare, so
// this file exists purely for isolated local dev (`npm run uae-compare`).
// See routes.js for the actual API implementation.
//
// Run locally:   npm run uae-compare        (default port 3300, override with UAE_COMPARE_PORT)

import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { uaeCompareApiRouter } from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, '..', '..', 'public', 'uae-compare')));
app.use(uaeCompareApiRouter());

const PORT = process.env.UAE_COMPARE_PORT || process.env.PORT || 3300;
app.listen(PORT, () => {
  console.log(`FNP vs Kapruka UAE price dashboard running at http://localhost:${PORT}`);
});
