// netlify/functions/lib/ladder-token.js
//
// Single-use, expiring action tokens for ladder links that carry their own auth
// (no login needed) — the same trust model as the player magic link
// (lib/player-auth.js): a random id stored in a blob, marked used on first
// consume. Used for:
//   type 'claim'         — a promoted waitlister claims their held spot
//   type 'venmo-confirm' — organizer one-tap confirms a Venmo payment
//   type 'venmo-decline' — organizer one-tap declines it
//
//   ladder-tokens  token/<token>.json
//   { token, type, eventId, playerId, email, action, createdAt, expiresAt, used }

import { getStore } from '@netlify/blobs';

const STORE = 'ladder-tokens';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

export async function createLadderToken({ type, eventId, playerId = null, email = null, action = null, ttlMs }) {
  const token = randomId(24); // 48 hex chars
  await store().setJSON(`token/${token}.json`, {
    token, type, eventId, playerId,
    email: email ? email.toLowerCase() : null,
    action,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.max(60000, ttlMs || 0)).toISOString(),
    used: false,
  });
  return token;
}

/** Consume a token (single-use). Returns the record, or null if invalid/expired/used. */
export async function consumeLadderToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const s = store();
  const key = `token/${token}.json`;
  const rec = await s.get(key, { type: 'json' }).catch(() => null);
  if (!rec || rec.used) return null;
  if (new Date(rec.expiresAt).getTime() < Date.now()) return null;
  // Mark used BEFORE the caller acts, so a forwarded/duplicated link can't double-fire.
  try {
    await s.setJSON(key, { ...rec, used: true, usedAt: new Date().toISOString() });
  } catch {
    return null;
  }
  return rec;
}

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
