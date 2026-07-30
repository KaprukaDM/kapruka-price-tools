// Partner registry — stored in Supabase (via src/db.js), shared between every
// running instance of this app. Used to live in config/partners.json, but
// that's a per-machine file: one instance adding a partner was invisible to
// any other instance until someone manually git-synced the file — a
// recurring source of confusion once this app started running from more
// than one server.

import { listPartnerRows, getPartnerRow, insertPartnerRow } from '../db.js';

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

// Persist a new partner and return it with its id. `kaprukaUrl` is the pasted
// Kapruka link (partner storefront OR brand/category listing); it's parsed at
// fetch time by parseKaprukaSource().
export async function addPartner({ name, kaprukaUrl, partnerSite, partnerLabel, platform, viaBrowser }) {
  let id = slugify(name);
  const base = id;
  let n = 2;
  while (await getPartnerRow(id)) id = `${base}-${n++}`;
  const partner = { id, name, kaprukaUrl, partnerSite, partnerLabel, platform, viaBrowser };
  await insertPartnerRow(partner);
  return partner;
}

// A partner + its id. Falls back to the oldest-added partner if the given id
// is missing/unknown; throws only when none exist at all.
export async function getPartner(id) {
  if (id) {
    const found = await getPartnerRow(id);
    if (found) return found;
  }
  const [first] = await listPartnerRows();
  if (!first) throw new Error('No partners configured yet — add one from the Comparison page.');
  return first;
}

// Lightweight list for the UI dropdown / API.
export async function listPartners() {
  const rows = await listPartnerRows();
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    kaprukaSlug: p.kaprukaSlug,
    partnerLabel: p.partnerLabel || p.partnerSite,
  }));
}
