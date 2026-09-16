// netlify/functions/lib/login-code.js
// Six-digit sign-in codes that ride along with every magic-link email.
//
// Why: when the site is installed as a home-screen app, tapping the emailed
// link opens the system browser — a different cookie jar — so the app itself
// never gets signed in. A code typed INTO the app fixes that (same pattern as
// the Pringle Group sign-in). The code is bound to the same one-time token the
// link carries: whichever is used first wins, the other stops working.
//
// Storage: `login-codes` store, key code/<scope>/<email>.json
//   { code, token, expiresAt, attempts }
// One live code per (scope, email); a new request replaces it.

import { getStore } from '@netlify/blobs';

const MAX_ATTEMPTS = 6;

function store() { return getStore('login-codes'); }
function key(scope, email) { return `code/${scope}/${String(email || '').toLowerCase()}.json`; }

/** Mint a code for this token. Returns the 6-digit string to put in the email. */
export async function issueLoginCode({ scope, email, token, minutes = 15 }) {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  const code = String(arr[0] % 1000000).padStart(6, '0');
  await store().setJSON(key(scope, email), {
    code, token,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
    attempts: 0,
  });
  return code;
}

/**
 * Check a typed code. Returns the token to consume on success, otherwise
 * { error } with a user-facing message. Wrong guesses are counted; after
 * MAX_ATTEMPTS the code is burned and the player has to request a new one.
 */
export async function redeemLoginCode({ scope, email, code }) {
  const k = key(scope, email);
  const rec = await store().get(k, { type: 'json' }).catch(() => null);
  const typed = String(code || '').replace(/\D/g, '');
  if (!rec) return { error: 'No code is waiting for that email. Request a new sign-in email.' };
  if (new Date(rec.expiresAt).getTime() < Date.now()) {
    await store().delete(k).catch(() => null);
    return { error: 'That code has expired. Request a new sign-in email.' };
  }
  if (typed.length !== 6 || typed !== rec.code) {
    rec.attempts = (rec.attempts || 0) + 1;
    if (rec.attempts >= MAX_ATTEMPTS) {
      await store().delete(k).catch(() => null);
      return { error: 'Too many wrong codes. Request a new sign-in email.' };
    }
    await store().setJSON(k, rec).catch(() => null);
    return { error: `That code isn’t right. ${MAX_ATTEMPTS - rec.attempts} tr${MAX_ATTEMPTS - rec.attempts === 1 ? 'y' : 'ies'} left.` };
  }
  await store().delete(k).catch(() => null);
  return { token: rec.token };
}
