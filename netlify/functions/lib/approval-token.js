// netlify/functions/lib/approval-token.js
//
// Single-use, expiring tokens for the one-tap Approve / Deny links in the
// "needs your approval" emails sent to league admins. Same keyless trust model
// as lib/ladder-token.js (Venmo confirm) and lib/potw-token.js: an unguessable
// 48-hex-char id stored in a blob, marked used on first consume — no login.
//
//   approval-tokens  token/<token>.json
//   { token, kind: 'profile' | 'roster', action: 'approve' | 'reject' | 'view',
//     teamId, playerId, createdAt, expiresAt, used }
//
// 'view' tokens are NOT single-use: they let the email's <img> load the pending
// photo (player-photo-serve ...&pending=1&t=<token>) so the admin can see what
// they're approving without signing in. They expire with the pair.

import { getStore } from '@netlify/blobs';

const STORE = 'approval-tokens';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

const DEFAULT_TTL_MS = 14 * 24 * 3600 * 1000;

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function valid(token) { return !!token && /^[a-f0-9]{48}$/.test(token); }

/**
 * @param {{ kind:'profile'|'roster', action:'approve'|'reject'|'view', teamId?:string|null, playerId:string, ttlMs?:number }} o
 * @returns {Promise<string>} the token (48 hex chars)
 */
export async function createApprovalToken({ kind, action, teamId = null, playerId, ttlMs }) {
  const token = randomId(24);
  await store().setJSON(`token/${token}.json`, {
    token, kind, action,
    teamId: teamId || null,
    playerId: String(playerId),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + Math.max(60000, ttlMs || DEFAULT_TTL_MS)).toISOString(),
    used: false,
  });
  return token;
}

/** Approve + deny + photo-view tokens for one pending item, in one call. */
export async function createApprovalLinks({ kind, teamId = null, playerId, ttlMs }) {
  const [approve, reject, view] = await Promise.all([
    createApprovalToken({ kind, action: 'approve', teamId, playerId, ttlMs }),
    createApprovalToken({ kind, action: 'reject', teamId, playerId, ttlMs }),
    createApprovalToken({ kind, action: 'view', teamId, playerId, ttlMs }),
  ]);
  return { approve, reject, view };
}

/** Read without consuming. null if invalid / expired / already used. */
export async function peekApprovalToken(token) {
  if (!valid(token)) return null;
  const rec = await store().get(`token/${token}.json`, { type: 'json' }).catch(() => null);
  if (!rec || rec.used) return null;
  if (new Date(rec.expiresAt).getTime() < Date.now()) return null;
  return rec;
}

/** Consume (single-use). Marks used BEFORE the caller acts so a forwarded or re-opened link can't double-fire. */
export async function consumeApprovalToken(token) {
  if (!valid(token)) return null;
  const s = store();
  const key = `token/${token}.json`;
  const rec = await s.get(key, { type: 'json' }).catch(() => null);
  if (!rec || rec.used) return null;
  if (new Date(rec.expiresAt).getTime() < Date.now()) return null;
  try {
    await s.setJSON(key, { ...rec, used: true, usedAt: new Date().toISOString() });
  } catch {
    return null;
  }
  return rec;
}
