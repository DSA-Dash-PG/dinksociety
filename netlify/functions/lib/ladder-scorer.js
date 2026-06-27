// netlify/functions/lib/ladder-scorer.js
// "Scorer" access — a shareable, per-night scoring credential so a courtside
// helper can run ONE ladder night's scoreboard without a full admin login.
//
// The link carries a stateless HMAC token over `${eventId}|${expiresMs}` (no
// storage, reusable until it expires — unlike the single-use action tokens in
// lib/ladder-token.js). A scorer can run the night (seed, scores, subs, finish)
// but the token is scoped to one event and grants nothing else.

import crypto from 'crypto';
import { verifyAdminSession } from './auth.js';

function secret() {
  const env = (k) => (typeof Netlify !== 'undefined' && Netlify.env.get(k)) || process.env[k];
  return env('SCORER_LINK_SECRET') || env('NOTIFY_PREFS_SECRET') || 'ds-scorer-link-fallback-secret-change-me';
}
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const sign = (p) => crypto.createHmac('sha256', secret()).update(p).digest('hex');

/** Mint a scorer token for an event that stays valid until `expiresMs`. */
export function makeScorerToken(eventId, expiresMs) {
  const p = b64url(`${eventId}|${Math.floor(expiresMs)}`);
  return `${p}.${sign(p)}`;
}

/** Verify a scorer token → { eventId, expiresMs } or null (bad sig / expired). */
export function readScorerToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  let expected;
  try { expected = sign(p); } catch { return null; }
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let eventId, expiresMs;
  try { [eventId, expiresMs] = unb64url(p).split('|'); expiresMs = Number(expiresMs); } catch { return null; }
  if (!eventId || !Number.isFinite(expiresMs) || expiresMs < Date.now()) return null;
  return { eventId, expiresMs };
}

function tokenFromReq(req) {
  const h = req.headers.get('x-scorer-token');
  if (h) return h;
  try { return new URL(req.url).searchParams.get('t') || null; } catch { return null; }
}

/**
 * Authorize a scoring request. An admin session always wins. Otherwise a valid
 * scorer token grants access, scoped to its event: pass the request's eventId to
 * require a match, or null for event-agnostic reads (e.g. the master roster).
 * @returns {Promise<{ ok:boolean, admin?:boolean, scorer?:boolean, eventId?:string }>}
 */
export async function authScoreAccess(req, eventId = null) {
  const v = await verifyAdminSession(req);
  if (v.valid) return { ok: true, admin: true };
  const rec = readScorerToken(tokenFromReq(req));
  if (rec && (!eventId || rec.eventId === eventId)) return { ok: true, scorer: true, eventId: rec.eventId };
  return { ok: false };
}
