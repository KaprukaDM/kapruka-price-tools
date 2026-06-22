// Partner registry. Each partner pairs a Kapruka partner-page slug with the
// partner's own website, so the comparison tool can be pointed at any partner
// just by adding an entry to config/partners.json — no code changes.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARTNERS_PATH = join(__dirname, '..', '..', 'config', 'partners.json');

export async function loadPartners() {
  const raw = await readFile(PARTNERS_PATH, 'utf-8');
  return JSON.parse(raw);
}

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'partner';

// A clean display label from a site URL: the host without "www.".
export function siteLabel(site) {
  try {
    return new URL(site.startsWith('http') ? site : `https://${site}`).host.replace(/^www\./, '');
  } catch {
    return site;
  }
}

// Persist a new partner to config/partners.json and return it with its id.
// `kaprukaUrl` is the pasted Kapruka link (partner storefront OR brand/category
// listing); it's parsed at fetch time by parseKaprukaSource().
export async function addPartner({ name, kaprukaUrl, partnerSite, partnerLabel, platform }) {
  const partners = await loadPartners();
  let id = slugify(name);
  const base = id;
  let n = 2;
  while (partners[id]) id = `${base}-${n++}`;
  partners[id] = {
    name,
    kaprukaUrl,
    partnerSite,
    partnerLabel,
    ...(platform ? { platform } : {}),
  };
  await writeFile(PARTNERS_PATH, JSON.stringify(partners, null, 2) + '\n');
  return { id, ...partners[id] };
}

// A partner config + its id, or throws if the id is unknown.
export async function getPartner(id) {
  const partners = await loadPartners();
  const ids = Object.keys(partners);
  const chosen = id && partners[id] ? id : ids[0];
  if (!chosen) throw new Error('No partners configured in config/partners.json');
  return { id: chosen, ...partners[chosen] };
}

// Lightweight list for the UI dropdown / API.
export async function listPartners() {
  const partners = await loadPartners();
  return Object.entries(partners).map(([id, p]) => ({
    id,
    name: p.name,
    kaprukaSlug: p.kaprukaSlug,
    partnerLabel: p.partnerLabel || p.partnerSite,
  }));
}
