// Sinhala-script → Latin transliteration and fuzzy "sounds-alike" token
// comparison, so a partner listing written in Sinhala script ("ලස්සන වසිලිස්සා")
// can be matched to Kapruka's romanized title ("LASSANA WASILISSA").
//
// normalizeName() strips every non-[a-z0-9] character, so before this a
// Sinhala-script title simply vanished into an empty token set (only any Latin
// words in it survived). Romanization is inherently loose — there is no single
// spelling ("Wasileessa" / "Wasilissa" / "Vasilissa") — so matching on the
// transliteration needs a phonetic fold plus a small edit-distance tolerance
// rather than exact token equality.

const SINHALA_RE = /[඀-෿]/;
export const hasSinhala = (s) => SINHALA_RE.test(String(s || ''));

const CONSONANTS = {
  0x0d9a: 'k', 0x0d9b: 'kh', 0x0d9c: 'g', 0x0d9d: 'gh', 0x0d9e: 'ng', 0x0d9f: 'ng',
  0x0da0: 'ch', 0x0da1: 'chh', 0x0da2: 'j', 0x0da3: 'jh', 0x0da4: 'ny', 0x0da5: 'gn', 0x0da6: 'nj',
  0x0da7: 't', 0x0da8: 'th', 0x0da9: 'd', 0x0daa: 'dh', 0x0dab: 'n', 0x0dac: 'nd',
  0x0dad: 't', 0x0dae: 'th', 0x0daf: 'd', 0x0db0: 'dh', 0x0db1: 'n', 0x0db3: 'nd',
  0x0db4: 'p', 0x0db5: 'ph', 0x0db6: 'b', 0x0db7: 'bh', 0x0db8: 'm', 0x0db9: 'mb',
  0x0dba: 'y', 0x0dbb: 'r', 0x0dbd: 'l', 0x0dc0: 'v',
  0x0dc1: 'sh', 0x0dc2: 'sh', 0x0dc3: 's', 0x0dc4: 'h', 0x0dc5: 'l', 0x0dc6: 'f',
};
const INDEPENDENT_VOWELS = {
  0x0d85: 'a', 0x0d86: 'aa', 0x0d87: 'ae', 0x0d88: 'aae', 0x0d89: 'i', 0x0d8a: 'ii',
  0x0d8b: 'u', 0x0d8c: 'uu', 0x0d8d: 'ru', 0x0d91: 'e', 0x0d92: 'ee', 0x0d93: 'ai',
  0x0d94: 'o', 0x0d95: 'oo', 0x0d96: 'au',
};
const VOWEL_SIGNS = {
  0x0dcf: 'aa', 0x0dd0: 'ae', 0x0dd1: 'aae', 0x0dd2: 'i', 0x0dd3: 'ii', 0x0dd4: 'u',
  0x0dd6: 'uu', 0x0dd8: 'ru', 0x0dd9: 'e', 0x0dda: 'ee', 0x0ddb: 'ai', 0x0ddc: 'o',
  0x0ddd: 'oo', 0x0dde: 'au',
};
const VIRAMA = 0x0dca;
const ANUSVARA = 0x0d82;
const VISARGA = 0x0d83;
const ZWJ = 0x200d;

// Replace every run of Sinhala script in `s` with its Latin transliteration,
// leaving everything else as is. A consonant carries an inherent "a" unless a
// vowel sign or virama (්) follows it; ZWJ (used in conjuncts like ශ්‍රී) is
// ignored, which makes "ශ්‍රී" come out "shrii" as intended.
export function transliterateSinhala(s) {
  const str = String(s || '');
  if (!hasSinhala(str)) return str;
  let out = '';
  const chars = [...str];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i].codePointAt(0);
    if (c === ZWJ) continue;
    if (CONSONANTS[c]) {
      out += CONSONANTS[c];
      const next = chars[i + 1]?.codePointAt(0);
      if (next === VIRAMA) { i++; continue; } // no inherent vowel
      if (VOWEL_SIGNS[next]) { out += VOWEL_SIGNS[next]; i++; continue; }
      out += 'a';
    } else if (INDEPENDENT_VOWELS[c]) {
      out += INDEPENDENT_VOWELS[c];
    } else if (c === ANUSVARA) {
      out += 'n';
    } else if (c === VISARGA) {
      out += 'h';
    } else if (c >= 0x0d80 && c <= 0x0dff) {
      out += ' '; // stray sign / unsupported letter — keep words separated
    } else {
      out += chars[i];
    }
  }
  return out;
}

// Fold a romanized token to a rough pronunciation key so common spelling
// variants collapse together ("wasileessa" and "vasilissa" → "vasilisa").
export function phoneticKey(token) {
  let t = String(token || '').toLowerCase();
  t = t
    .replace(/(th|dh|kh|gh|bh|ph|chh|ch|sh)/g, (m) => ({ th: 't', dh: 'd', kh: 'k', gh: 'g', bh: 'b', ph: 'p', chh: 'c', ch: 'c', sh: 's' }[m]))
    .replace(/w/g, 'v')
    .replace(/z/g, 's')
    .replace(/x/g, 'ks')
    .replace(/q/g, 'k')
    .replace(/(aa|ae|ea|ai|au)/g, 'a')
    .replace(/(ee|ii|ie|ei)/g, 'i')
    .replace(/(oo|uu|ou)/g, 'u')
    .replace(/e/g, 'i')
    .replace(/o/g, 'u')
    .replace(/h/g, '')
    .replace(/(.)\1+/g, '$1');
  return t;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

// Do two tokens sound alike? Tokens containing digits must be identical (so
// "grade 4" never matches "grade 5"); otherwise equal phonetic keys, or keys
// within ~25% edit distance once long enough for that to mean something.
export function soundsAlike(a, b) {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  if (ka === kb) return true;
  const longest = Math.max(ka.length, kb.length);
  if (Math.min(ka.length, kb.length) < 4) return false;
  // Romanizations vary in vowels and aspirates, almost never the first
  // consonant — "jathaka" and "mataka" are different words, not spellings.
  if (ka[0] !== kb[0]) return false;
  return levenshtein(ka, kb) / longest <= 0.25;
}

// Fuzzy token-set overlap for two tokenized names. Returns the jaccard over
// the greedily paired "sounds alike" tokens, plus whether any digit-bearing
// token on either side is left unpaired (a different grade/volume/number ⇒ a
// different product regardless of how well the words line up).
export function fuzzyOverlap(aTokens, bTokens) {
  const a = [...aTokens];
  const b = [...bTokens];
  if (!a.length || !b.length) return { jaccard: 0, numberMismatch: false };
  const usedB = new Set();
  const pairedA = new Set();
  // Exact matches first so a sounds-alike pass can't steal them.
  for (const t of a) {
    const j = b.findIndex((u, idx) => !usedB.has(idx) && u === t);
    if (j >= 0) { usedB.add(j); pairedA.add(t); }
  }
  for (const t of a) {
    if (pairedA.has(t)) continue;
    const j = b.findIndex((u, idx) => !usedB.has(idx) && soundsAlike(t, u));
    if (j >= 0) { usedB.add(j); pairedA.add(t); }
  }
  const inter = pairedA.size;
  const jaccard = inter / (a.length + b.length - inter);
  const unpairedDigit =
    a.some((t) => !pairedA.has(t) && /\d/.test(t)) ||
    b.some((u, idx) => !usedB.has(idx) && /\d/.test(u));
  return { jaccard, numberMismatch: unpairedDigit };
}
