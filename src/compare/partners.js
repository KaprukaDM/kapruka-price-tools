// Partner registry — stored in Supabase (via src/db.js), shared between every
// running instance of this app. Used to live in config/partners.json, but
// that's a per-machine file: one instance adding a partner was invisible to
// any other instance until someone manually git-synced the file — a
// recurring source of confusion once this app started running from more
// than one server.

import { listPartnerRows, getPartnerRow, insertPartnerRow, requestPartnerRefresh } from '../db.js';

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

// Lightweight list for the UI dropdown / API. Includes refreshRequestedAt so
// refresh-all-partners.js can decide whether a pending "Refresh" click still
// needs picking up, without a second round-trip per partner.
export async function listPartners() {
  const rows = await listPartnerRows();
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    kaprukaSlug: p.kaprukaSlug,
    partnerLabel: p.partnerLabel || p.partnerSite,
    refreshRequestedAt: p.refreshRequestedAt,
  }));
}

// Mark a partner as wanting a fresh scrape. Doesn't scrape anything itself —
// just records the request; the scheduled job (running from a confirmed-good
// Kapruka-geo host) is what actually acts on it, next time it runs.
export async function requestRefresh(id) {
  await requestPartnerRefresh(id);
}
