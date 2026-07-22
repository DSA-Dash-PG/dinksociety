// netlify/functions/lib/organizers.js
// Ladder ORGANIZERS — people the league owner has granted permission to run
// their OWN ladder nights, with NO access to the league backend or to any other
// organizer's ladders. An organizer is identified by email; they sign in through
// the normal player magic-link (they are also a player / lite account), and this
// store records whether that email is allowed to organize.
//
// Store: ladder-organizers   key: org/<normalizedEmail>.json
//   { email, name, status, playerId, invitedAt, invitedBy, updatedAt }
//
// status:
//   'active'     — may create/manage their own ladders
//   'suspended'  — access denied; the next organizer request is rejected
// Deleting the record removes them entirely.
//
// Strong consistency so a just-granted (or just-revoked) organizer is seen
// immediately on the next request — same rule sessions/scores follow.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';

const STORE = 'ladder-organizers';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

/** Fetch one organizer record by email, or null. */
export async function getOrganizer(email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  return store().get(`org/${norm}.json`, { type: 'json' }).catch(() => null);
}

/** Every organizer record, sorted by name. */
export async function listOrganizers() {
  const s = store();
  const { blobs } = await s.list({ prefix: 'org/' }).catch(() => ({ blobs: [] }));
  const out = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)));
  return out.filter(Boolean).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

/** Create/replace an organizer record (email is normalized + stamped). */
export async function setOrganizer(rec) {
  const norm = normalizeEmail(rec?.email);
  if (!norm) throw new Error('organizer email required');
  rec.email = norm;
  rec.updatedAt = new Date().toISOString();
  await store().setJSON(`org/${norm}.json`, rec);
  return rec;
}

/** Remove an organizer entirely. */
export async function deleteOrganizer(email) {
  const norm = normalizeEmail(email);
  if (!norm) return;
  await store().delete(`org/${norm}.json`).catch(() => null);
}

/** True only for an email that is a currently-active organizer. */
export async function isActiveOrganizer(email) {
  const rec = await getOrganizer(email);
  return !!rec && rec.status === 'active';
}
