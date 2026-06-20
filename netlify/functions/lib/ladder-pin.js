// netlify/functions/lib/ladder-pin.js
// Lightweight PIN gate for running/scoring a ladder night — so an organizer can
// score courtside without a full admin login (same idea as the old Pickleladder
// 4-digit PIN). The PIN comes from env LADDER_PIN (falls back to ADMIN_PIN). If
// neither is set, PIN auth is OFF (admin session still works).
//
// Sent as header `X-Ladder-Pin` or query `?pin=`. This only ever gates ladder
// scoring endpoints — never registration, payments, or the rest of admin.

export function ladderPinConfigured() {
  return !!(envv('LADDER_PIN') || envv('ADMIN_PIN'));
}

export function checkLadderPin(req) {
  const expected = envv('LADDER_PIN') || envv('ADMIN_PIN') || '';
  if (!expected) return false;
  let got = req.headers.get('x-ladder-pin') || '';
  if (!got) { try { got = new URL(req.url).searchParams.get('pin') || ''; } catch { /* noop */ } }
  return !!got && String(got) === String(expected);
}

function envv(k) {
  if (typeof Netlify !== 'undefined' && Netlify.env && Netlify.env.get(k)) return Netlify.env.get(k);
  return (typeof process !== 'undefined' && process.env && process.env[k]) || '';
}
