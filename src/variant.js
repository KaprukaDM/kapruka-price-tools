// Parse a requested storage variant (and a few other hints) from the user's query.

/**
 * Extract a normalized storage size like "512GB" / "1TB" from free text.
 * Returns null if none specified.
 */
export function parseStorage(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+)\s*(gb|tb)\b/i);
  if (!m) return null;
  return `${m[1]}${m[2].toUpperCase()}`;
}

/** Normalize a storage label found on a page to the same shape, e.g. "512 GB" -> "512GB". */
export function normalizeStorage(label) {
  if (!label) return null;
  const m = String(label).match(/(\d+)\s*(gb|tb)\b/i);
  return m ? `${m[1]}${m[2].toUpperCase()}` : null;
}
