// Text normalization + model-code extraction used to match products across the
// two catalogues (Kapruka partner page vs. the partner's own stopnshop.lk site).
//
// Product names differ a lot between the two sites ("Philips Hair Dryer 2100W
// ThermoProtect - BHD340/10 | ..." vs. "Philips Hair Dryer 2100W ThermoProtect
// MG3710"), so we match on (a) a strong model code shared by both names/SKUs and
// (b) the overlap of the remaining descriptive tokens.

// Marketing / filler words that carry no identity. Kept deliberately small so we
// don't accidentally strip meaningful tokens.
const STOPWORDS = new Set([
  'buy', 'online', 'for', 'the', 'and', 'with', 'in', 'of', 'sri', 'lanka',
  'price', 'new', 'genuine', 'original', 'best', 'a', 'an', 'to', 'by', 'on',
  'free', 'delivery', 'offer', 'sale', 'pack', 'piece', 'pieces', 'pcs', 'set',
]);

// Decode the HTML entities WooCommerce/RankMath leave in product names
// (&#8211; &#038; &amp; &quot; &#8217; etc.).
export function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

// Lowercase, decode, drop everything after a "|" (RankMath SEO tail), strip
// punctuation to spaces, collapse whitespace.
export function normalizeName(s) {
  return decodeEntities(s)
    .split('|')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Descriptive token set (model codes included), minus stopwords and 1-char noise.
export function tokenize(s) {
  const out = new Set();
  for (const t of normalizeName(s).split(' ')) {
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

// Pure spec tokens (a number immediately followed by a unit) — wattage, volume,
// weight, screen size etc. These look code-like but are NOT identity: two
// unrelated products often share "1000w" or "20l". Excluded from model codes.
const SPEC_TOKEN = /^\d+(?:\.\d+)?(w|kw|kg|g|l|ml|mah|wh|v|hz|cm|mm|k|in|inch)$/;

// Strong model codes: alphanumeric tokens with >=1 letter AND >=2 digits and
// length >=4 (bhd340, mg3710, eg200, dcm25n, br1948r, vkg32ee685, ogs709), minus
// spec tokens. Keeps real model numbers, drops wattage/size like 2100w / 350w /
// 6l that would otherwise cause false matches between different products.
export function extractModelCodes(s) {
  const out = new Set();
  for (const t of normalizeName(s).split(' ')) {
    if (t.length < 4 || SPEC_TOKEN.test(t)) continue;
    const letters = (t.match(/[a-z]/g) || []).length;
    const digits = (t.match(/[0-9]/g) || []).length;
    if (letters >= 1 && digits >= 2) out.add(t);
  }
  return out;
}

// Numeric specs (wattage, capacity) pulled from a name, grouped by unit:
//   "Bajaj ... 1000W Mixer 1.5L" -> { w: Set{1000}, l: Set{1.5} }
// Used to reject fuzzy name matches whose specs clearly disagree (a 1000W and a
// 750W appliance are different products even if their names overlap a lot).
export function extractSpecs(s) {
  const specs = {};
  const re = /(\d+(?:\.\d+)?)\s*(w|kw|kg|l|ml|mah|wh)\b/g;
  const norm = normalizeName(s);
  let m;
  while ((m = re.exec(norm))) {
    const unit = m[2] === 'kw' ? 'w' : m[2];
    const val = m[2] === 'kw' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
    (specs[unit] ||= new Set()).add(val);
  }
  return specs;
}

// True if two spec maps share a unit but have no overlapping value for it
// (e.g. one is 1000W and the other 750W) -> almost certainly different products.
export function specsConflict(a, b) {
  for (const unit of Object.keys(a)) {
    const bv = b[unit];
    if (!bv) continue;
    let overlap = false;
    for (const v of a[unit]) if (bv.has(v)) overlap = true;
    if (!overlap) return true;
  }
  return false;
}

// Two model codes are "the same" if equal, or one contains the other and the
// shorter is >=4 chars (handles "bhd340" vs "bhd34010", sku "philips_bhd340").
export function codesMatch(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.includes(short);
}
