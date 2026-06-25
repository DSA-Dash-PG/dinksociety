// netlify/functions/lib/ladder-players.js
// "Lite" ladder-only accounts — people who play ladders but are NOT on any
// league team. A league player lives as a roster entry inside a team blob; a
// lite player has no team, so we give them their own tiny record here.
//
// Identity is keyed on the NORMALIZED EMAIL, deliberately, so migration is
// trivial: the day a lite player joins a team (added to a team roster with the
// same email), findPlayerByEmail resolves them to that team FIRST — they become
// a full league player automatically, and their ladder history (signups,
// credit, stats — all email-keyed) follows them over with no conversion step.
//
// Store layout (blob store 'ladder-players'):
//   player/<playerId>.json  → the record  { playerId, name, email, normalizedEmail, gender, createdAt }
//   email/<norm>.json       → { playerId }   (fast email → id lookup, no list scan)
//
// playerId is prefixed `lp_` so it can never collide with a team roster id.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';

const STORE = 'ladder-players';

function store() { return getStore(STORE); }

function randomId(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Look up a lite player by email. Returns the record or null. */
export async function getLiteByEmail(rawEmail) {
  const norm = normalizeEmail(rawEmail);
  if (!norm) return null;
  const ptr = await store().get(`email/${norm}.json`, { type: 'json' }).catch(() => null);
  if (!ptr?.playerId) return null;
  return getLiteById(ptr.playerId);
}

/** Look up a lite player by their lp_ id. Returns the record or null. */
export async function getLiteById(playerId) {
  if (!playerId) return null;
  return store().get(`player/${playerId}.json`, { type: 'json' }).catch(() => null);
}

/**
 * Create a lite player (idempotent on email). If one already exists for that
 * email we return it untouched (optionally backfilling a missing name/gender).
 * Returns { record, created }.
 */
export async function createLitePlayer({ name, email, gender = null }) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error('A valid email is required.');

  const existing = await getLiteByEmail(norm);
  if (existing) {
    // Backfill blanks without clobbering anything they've already set.
    let changed = false;
    if (!existing.name && name) { existing.name = String(name).trim().slice(0, 80); changed = true; }
    if (!existing.gender && gender) { existing.gender = gender; changed = true; }
    if (changed) await store().setJSON(`player/${existing.playerId}.json`, existing);
    return { record: existing, created: false };
  }

  const playerId = `lp_${randomId(16)}`;
  const record = {
    playerId,
    name: String(name || '').trim().slice(0, 80) || 'Player',
    email: norm,
    normalizedEmail: norm,
    gender: gender || null,
    createdAt: new Date().toISOString(),
  };
  await store().setJSON(`player/${playerId}.json`, record);
  await store().setJSON(`email/${norm}.json`, { playerId });
  return { record, created: true };
}

/** True if this id is a lite ladder account (vs. a team roster id). */
export function isLiteId(playerId) {
  return typeof playerId === 'string' && playerId.startsWith('lp_');
}
