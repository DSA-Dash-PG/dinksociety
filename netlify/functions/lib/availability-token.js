// netlify/functions/lib/availability-token.js
//
// Stateless signed tokens for the one-tap "confirm your availability" buttons in
// the reminder email. Each button carries a token encoding
// { matchId, teamId, playerId, status }, HMAC-signed so a player can mark
// themselves in/out with one tap (no login) but nobody can forge a status for
// another player. The status is bound INTO the signature, so the "I'm in" and
// "Can't make it" links are two distinct, non-swappable tokens.
//
// Idempotent: the confirm endpoint just records the status, so a link is safe to
// re-hit and a player can flip their answer by tapping the other button.
//
// Secret: AVAILABILITY_TOKEN_SECRET, falling back to DROP_INGEST_TOKEN so the
// feature works without provisioning a new env var (a dedicated secret is better).

import { createHmac, timingSafeEqual } from 'node:crypto';

function secret() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('AVAILABILITY_TOKEN_SECRET'))
    || process.env.AVAILABILITY_TOKEN_SECRET
    || (typeof Netlify !== 'undefined' && Netlify.env.get('DROP_INGEST_TOKEN'))
    || process.env.DROP_INGEST_TOKEN
    || 'ds-availability-insecure-fallback';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  return b64url(createHmac('sha256', secret()).update(payload).digest());
}

/** Build a signed availability token for one player + status ('in' | 'out'). */
export function signAvailabilityToken({ matchId, teamId, playerId, status }) {
  const s = status === 'out' ? 'out' : 'in';
  const payload = b64url(JSON.stringify({ m: String(matchId), t: String(teamId), p: String(playerId), s }));
  return `${payload}.${sign(payload)}`;
}

/** Verify + decode a token. Returns { matchId, teamId, playerId, status } or null. */
export function verifyAvailabilityToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = sign(payload);
  let ok = false;
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    ok = a.length === b.length && timingSafeEqual(a, b);
  } catch { ok = false; }
  if (!ok) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const o = JSON.parse(json);
    return { matchId: o.m, teamId: o.t, playerId: o.p, status: o.s === 'out' ? 'out' : 'in' };
  } catch { return null; }
}
