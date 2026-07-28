// Persists the Kapruka SKU -> matching fnp.ae product URL pairings you set up
// in the dashboard, so Refresh doesn't require re-pasting links every time.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '..', '..', 'config', 'uae-pairings.json');

export async function loadPairings() {
  try {
    const raw = await readFile(FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function savePairings(pairings) {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(pairings, null, 2), 'utf8');
}

export async function setPairing(sku, fnpUrl) {
  const pairings = await loadPairings();
  if (fnpUrl) {
    pairings[sku] = fnpUrl;
  } else {
    delete pairings[sku];
  }
  await savePairings(pairings);
  return pairings;
}
