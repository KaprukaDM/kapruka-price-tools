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
// weight, screen size, storage/RAM, frequency, generation, UPS rating etc. These
// look code-like but are NOT identity: two unrelated products often share
// "1000w", "20l", "256gb" (a MacBook and an iPhone both have 256gb), "13th" gen,
// or a "650va" UPS rating. Excluded from model codes.
export const SPEC_TOKEN =
  /^\d+(?:\.\d+)?(w|kw|kwh|wh|mah|kg|g|mg|l|ml|v|va|hz|ghz|mhz|gb|tb|mb|kb|mp|cm|mm|k|p|th|in|inch)$/;

// CPU/processor model tokens: a run of digits followed by a known mobile-CPU
// suffix (Intel/AMD), e.g. 1335u, 150u, 13420h, 5800h, 1135g7. Different laptops
// share the same CPU, so these are NOT product identity.
const CPU_TOKEN = /^\d{3,5}(u|h|hx|hs|hk|p|k|y|e|t|g[1-9])$/;

// GPU model tokens: a known graphics-card family prefix immediately followed
// by its model number, e.g. rtx4060, rtx4070ti, gtx1660, rx6600, arc770,
// mx550. The prefix+digits join rule below (originally built for codes like
// "NF 9269") also fuses "RTX 4060" into "rtx4060", which then looked
// code-like enough to pass as a strong model code — but a GPU is a component
// shared across MANY different laptops (and standalone graphics cards), not
// identity for the laptop itself. Without this, "Asus ROG G615J ... RTX
// 4060" matched a completely different Lenovo laptop, and even a bare "RTX
// 4060" graphics card listing, purely because both mention the same GPU.
const GPU_TOKEN = /^(rtx|gtx|rx|arc|mx)\d{3,4}(ti|super)?$/;

// Strong model codes: alphanumeric tokens with >=1 letter AND >=2 digits and
// length >=4 (bhd340, mg3710, eg200, dcm25n, br1948r, vkg32ee685, ogs709), minus
// spec and CPU tokens. Keeps real model numbers, drops specs like 2100w / 256gb /
// 13th / 1335u that would otherwise cause false matches between different products.
//
// Some catalogues write the same code as two separate words instead of one —
// "Naviforce NF 9269 ..." vs. a partner site's "NF 9269 ..." both split the
// brand-prefix ("nf") from the number ("9269"), so neither half alone has both
// a letter and a digit and the whole thing was invisible to matching, even
// though both sides use the identical code. Join a short (1-3 letter) prefix
// immediately followed by a 3-6 digit run into one token first, so "nf 9269"
// becomes "nf9269" on both sides before the rule above is applied. Skipped for
// stopwords ("in 2024", "by 2025") so we don't manufacture false codes out of
// ordinary phrases that happen to precede a number.
function modelCodesOf(tokens) {
  const out = new Set();
  for (const t of tokens) {
    if (t.length < 4 || SPEC_TOKEN.test(t) || CPU_TOKEN.test(t) || GPU_TOKEN.test(t)) continue;
    const letters = (t.match(/[a-z]/g) || []).length;
    const digits = (t.match(/[0-9]/g) || []).length;
    if (letters >= 1 && digits >= 2) out.add(t);
  }
  return out;
}

export function extractModelCodes(s) {
  const joined = normalizeName(s).replace(/\b([a-z]{1,3}) (\d{3,6})\b/g, (whole, prefix, digits) =>
    STOPWORDS.has(prefix) ? whole : prefix + digits,
  );
  return modelCodesOf(joined.split(' '));
}

// Same as extractModelCodes(), but excludes codes that only exist because the
// prefix+digits join above glued two separate words together. A code already
// fused in the source text (native) is reliable SKU identity. A joined one is
// weaker: the same join that turns "NF 9269" into "nf9269" also turns "MRF
// 100" (a tyre brand followed by its width, not a SKU) into "mrf100", making
// two differently-sized tyres of the same brand look like a strong code
// match. Callers can use this to only trust a code match enough to skip
// other checks (like a spec-conflict veto) when it's native.
export function extractNativeModelCodes(s) {
  return modelCodesOf(normalizeName(s).split(' '));
}

// normalizeName() strips "." to a space, which silently corrupts decimal
// capacities before extractSpecs ever sees them: "4.5L" -> "4 5l" -> the unit
// regex below reads that as a bare "5l", losing the "4." entirely. Two
// genuinely different capacities (e.g. "1.2L" and "2.2L") then both collapse
// to the same trailing-digit value ("2l") and register as agreeing —
// exactly backwards for a check whose whole job is telling different specs
// apart. Protect digit.digit sequences through the strip so "4.5l" survives
// as "4.5l", then run the normal punctuation strip around it.
function specNormalize(s) {
  return decodeEntities(s)
    .split('|')[0]
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, '$1decimalpoint$2') // protect the decimal point through the strip below (lowercase: this runs after toLowerCase(), and only lowercase letters survive the next step)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/decimalpoint/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

// Numeric specs (wattage, capacity) pulled from a name, grouped by unit:
//   "Bajaj ... 1000W Mixer 1.5L" -> { w: Set{1000}, l: Set{1.5} }
// Used to reject fuzzy name matches whose specs clearly disagree (a 1000W and a
// 750W appliance are different products even if their names overlap a lot).
export function extractSpecs(s) {
  const specs = {};
  const norm = specNormalize(s);
  // "g" (grams) matters — chocolates/groceries are almost always weighed in
  // bare grams ("130g"), not kg — without it, two products with genuinely
  // different weights had NOTHING to disagree on, and (worse) two identical
  // products had nothing to positively agree on either, since specsConflict
  // and audit-scoring's hasAgreeingSpec only see units this regex captures.
  // \b after the unit means "128gb" can't accidentally register as a "g"
  // match (no word boundary between the g and the following b).
  const re = /(\d+(?:\.\d+)?)\s*(w|kw|kg|g|l|ml|mah|wh)\b/g;
  let m;
  while ((m = re.exec(norm))) {
    const unit = m[2] === 'kw' ? 'w' : m[2];
    const val = m[2] === 'kw' ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
    (specs[unit] ||= new Set()).add(val);
  }
  // Storage/RAM capacity ("128GB", "6GB RAM") — same "gb" unit but different
  // dimensions, so track them separately: a bare "Xgb" is storage, "Xgb ram"
  // (ram immediately follows) is RAM. Phones/tablets are frequently named
  // purely by spec with no SKU code at all ("Galaxy Tab S9 FE 5G 6GB
  // 128GB") — tracking this lets a code-less name still positively confirm
  // it's the same variant (see audit-scoring.js's fallback path) instead of
  // just failing to reject a different one.
  const gbMatches = [...norm.matchAll(/(\d+)gb(\s+ram)?/g)];
  const anyLabeled = gbMatches.some((m) => m[2]);
  if (anyLabeled) {
    // At least one side spells out "ram" — trust the label per match.
    for (const m of gbMatches) {
      const key = m[2] ? 'ram_gb' : 'storage_gb';
      (specs[key] ||= new Set()).add(parseFloat(m[1]));
    }
  } else if (gbMatches.length >= 2) {
    // Nothing labeled at all ("8GB 256GB") — every site tonight that omits
    // "RAM"/"ROM" still lists RAM before storage, so use that position.
    // Without this, "8GB 256GB" (8GB RAM) and "12GB 256GB" (12GB RAM) both
    // land in one shared bucket and "agree" on the 256 they both happen to
    // have — silently masking a real 8GB-vs-12GB RAM difference.
    (specs.ram_gb ||= new Set()).add(parseFloat(gbMatches[0][1]));
    for (let i = 1; i < gbMatches.length; i++) {
      (specs.storage_gb ||= new Set()).add(parseFloat(gbMatches[i][1]));
    }
  } else if (gbMatches.length === 1) {
    (specs.storage_gb ||= new Set()).add(parseFloat(gbMatches[0][1]));
  }
  // Tyre size (width/aspect-ratio-rim, e.g. "100/90-17" or "195/65R15" — both
  // normalize to "100 90 17" / "195 65r15" once punctuation is stripped).
  // Two tyres from the same brand and tread pattern name routinely share
  // every descriptive word ("MRF Zapper", "Timsun TS-...") while being a
  // completely different size — e.g. a 100/90-17 and a 100/90-10 are not
  // interchangeable despite an almost-identical name. Bounded to plausible
  // tyre dimensions (width/aspect/rim ranges) so this doesn't fire on
  // unrelated numeric triples in other product names.
  const TIRE_RE = /\b(\d{2,3})\s+(\d{2})r?[\s-]*(\d{2})\b/g;
  let tm;
  while ((tm = TIRE_RE.exec(norm))) {
    const width = parseInt(tm[1], 10);
    const aspect = parseInt(tm[2], 10);
    const rim = parseInt(tm[3], 10);
    if (width >= 60 && width <= 315 && aspect >= 20 && aspect <= 95 && rim >= 8 && rim <= 24) {
      (specs.tire_rim ||= new Set()).add(rim);
      (specs.tire_size ||= new Set()).add(width * 1000 + aspect); // width+aspect as one comparable value
    }
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
