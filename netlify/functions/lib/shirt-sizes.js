// netlify/functions/lib/shirt-sizes.js
// Player shirt sizes — so the league can order shirts for everyone.
//
// Stored ONCE PER PERSON, not per roster entry: a returning player gets a new
// roster id on a new team blob every season, so a size kept on the roster
// would have to be re-asked each time. The key is the normalized email (the
// same identity the rest of the league uses); a player with no email falls
// back to their player id.
//
//   shirt-sizes  sizes.json → { [key]: { size, cut, updatedAt, by } }
//     key  = normalized email  |  'id:<playerId>'
//     size = XS | S | M | L | XL | 2XL | 3XL
//     cut  = 'unisex' | 'womens'
//     by   = 'player' | 'admin'
//
// Private: never emitted by any public endpoint. A player sees their own; the
// league admin sees everyone's.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';

export const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
export const CUTS = ['unisex', 'womens'];

const store = () => getStore({ name: 'shirt-sizes', consistency: 'strong' });

export function cleanSize(v) {
  const s = String(v || '').trim().toUpperCase().replace(/^XXXL$/, '3XL').replace(/^XXL$/, '2XL');
  return SIZES.includes(s) ? s : null;
}
export function cleanCut(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return s === 'womens' || s === 'women' ? 'womens' : s === 'unisex' || s === 'mens' || s === 'men' ? 'unisex' : null;
}

/** Storage key for a person: their normalized email, else their player id. */
export function sizeKey({ email, playerId } = {}) {
  const e = normalizeEmail(email) || String(email || '').trim().toLowerCase();
  if (e) return e;
  return playerId ? `id:${playerId}` : null;
}

export async function getAllSizes() {
  const d = await store().get('sizes.json', { type: 'json' }).catch(() => null);
  return (d && typeof d === 'object') ? d : {};
}

/** Look a person up — by email first, then by the player-id fallback key. */
export function lookupSize(all, { email, playerId } = {}) {
  const k = sizeKey({ email });
  return (k && all[k]) || (playerId && all[`id:${playerId}`]) || null;
}

/** Set (or, with size=null, clear) one person's size. Returns the saved record or null. */
export async function setSize({ email, playerId }, { size, cut }, by = 'player') {
  const key = sizeKey({ email, playerId });
  if (!key) throw new Error('No email or player id to save against');
  const all = await getAllSizes();
  if (size == null) { delete all[key]; await store().setJSON('sizes.json', all); return null; }
  const rec = { size, cut: cut || all[key]?.cut || 'unisex', updatedAt: new Date().toISOString(), by };
  all[key] = rec;
  // Once someone has an email-keyed record, drop their id-keyed placeholder.
  if (playerId && key !== `id:${playerId}`) delete all[`id:${playerId}`];
  await store().setJSON('sizes.json', all);
  return rec;
}

/**
 * Order sheet: counts per cut + size, plus how many people are still missing.
 * rows = [{ size, cut }] — one row per PERSON (dedupe before calling).
 */
export function tally(rows) {
  const counts = {};
  for (const cut of CUTS) { counts[cut] = {}; for (const s of SIZES) counts[cut][s] = 0; }
  let have = 0, missing = 0;
  for (const r of rows) {
    if (r.size && counts[r.cut || 'unisex']) { counts[r.cut || 'unisex'][r.size]++; have++; }
    else missing++;
  }
  return { counts, have, missing, total: rows.length };
}
