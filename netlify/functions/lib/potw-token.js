// netlify/functions/lib/potw-token.js
// Single-use tokens for the one-tap "Approve & send" links in the weekly
// K'CHN Player of the Week approval email. Same keyless model as
// lib/ladder-token.js: an unguessable random id stored in a blob, marked used
// on first consume. No HMAC secret — security rests on the 48-hex-char id plus
// strong-consistency mark-used-before-acting.
//
// The approval link is two-step on purpose (see potw-approve.js): GET peeks the
// token to render a confirm page WITHOUT consuming it (so an email-client link
// prefetch can't fire a send), and the POST consumes it and sends.

import { getStore } from '@netlify/blobs';

const STORE = 'potw-tokens';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create an approve token tied to one winner of one week.
 * @param {{ circuit:string, week:number, winnerKey:'men'|'women', ttlMs?:number }} o
 * @returns {Promise<string>} the token (48 hex chars)
 */
export async function createPotwToken({ circuit, week, winnerKey, ttlMs }) {
  const token = randomId(24);
  await store().setJSON(`token/${token}.json`, {
    token,
    type: 'potw-approve',
    circuit: String(circuit),
    week: Number(week),
    winnerKey,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.max(60000, ttlMs || 14 * 24 * 3600 * 1000)).toISOString(),
    used: false,
  });
  return token;
}

/** Read a token without consuming it (for the GET confirm page). null if invalid/expired/used. */
export async function peekPotwToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const rec = await store().get(`token/${token}.json`, { type: 'json' }).catch(() => null);
  if (!rec || rec.used) return null;
  if (new Date(rec.expiresAt).getTime() < Date.now()) return null;
  return rec;
}

/** Consume a token (single-use). Returns the record, or null if invalid/expired/used. */
export async function consumePotwToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const s = store();
  const key = `token/${token}.json`;
  const rec = await s.get(key, { type: 'json' }).catch(() => null);
  if (!rec || rec.used) return null;
  if (new Date(rec.expiresAt).getTime() < Date.now()) return null;
  // Mark used BEFORE the caller sends, so a duplicated/forwarded link can't double-fire.
  try {
    await s.setJSON(key, { ...rec, used: true, usedAt: new Date().toISOString() });
  } catch {
    return null;
  }
  return rec;
}
