// netlify/functions/lib/potw-size-token.js
//
// Stateless signed tokens for the one-tap "claim your shirt size" buttons in the
// K'CHN Player of the Week congrats email. Each winner's email carries a token
// encoding { circuit, week, winnerKey }, HMAC-signed so a player can record their
// size with one tap but nobody can forge a size submission for another winner.
//
// Unlike lib/potw-token.js (single-use random approve ids stored in a blob), these
// are stateless: the size endpoint is idempotent and safe to re-hit, so a player
// can change their mind by tapping a different size. No blob lookup needed to
// validate the click.
//
// Secret: POTW_TOKEN_SECRET (falls back to DROP_INGEST_TOKEN so the feature works
// without a new env var, though a dedicated secret is recommended).

import { createHmac, timingSafeEqual } from 'node:crypto';

function secret() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('POTW_TOKEN_SECRET'))
    || process.env.POTW_TOKEN_SECRET
    || (typeof Netlify !== 'undefined' && Netlify.env.get('DROP_INGEST_TOKEN'))
    || process.env.DROP_INGEST_TOKEN
    || 'ds-potw-insecure-fallback';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  return b64url(createHmac('sha256', secret()).update(payload).digest());
}

/** Build a signed size token for one winner of one week. */
export function signSizeToken({ circuit, week, winnerKey }) {
  const payload = b64url(JSON.stringify({ c: String(circuit), w: Number(week), k: winnerKey }));
  return `${payload}.${sign(payload)}`;
}

/** Verify + decode a size token. Returns { circuit, week, winnerKey } or null. */
export function verifySizeToken(token) {
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
    return { circuit: o.c, week: o.w, winnerKey: o.k };
  } catch { return null; }
}
