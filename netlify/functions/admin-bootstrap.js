// netlify/functions/admin-bootstrap.js
// Single sign-on bridge to the ADMIN portal. A user already signed in as a
// player OR captain, whose email is in ADMIN_EMAILS, gets an admin session
// minted directly from that session — no second magic-link login. The player
// portal (me.html) and captain portal (captain.html) call this when an admin
// taps the "Admin" toggle, then navigate to /admin.html.
//
// Mirrors captain-bootstrap (the player→captain bridge) and reuses the exact
// session shape + cookie that admin-link.js issues, so the admin portal can't
// tell the difference between a magic-link login and a bridged one.

import { getStore } from '@netlify/blobs';
import crypto from 'crypto';
import { verifyPlayerSession, verifyCaptainSession } from './lib/auth.js';
import { isAdminEmail } from './lib/admin-auth.js';
import { recordLogin } from './lib/activity-log.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Accept either an active player OR captain session — whichever portal the
  // admin tapped the toggle from. We only need the authenticated email.
  let email = null;
  const player = await verifyPlayerSession(req);
  if (player.valid) {
    email = player.payload?.session?.email || null;
  } else {
    const captain = await verifyCaptainSession(req);
    if (captain.valid) email = captain.payload?.session?.email || null;
  }

  if (!email) {
    return json({ error: 'Sign in as a player or captain first' }, 401);
  }

  // The signed-in account must actually be an admin.
  if (!isAdminEmail(email)) {
    return json({ error: 'This account does not have admin access' }, 403);
  }

  const normalized = String(email).trim().toLowerCase();

  // Mint an admin session — same store, shape, and TTL as admin-link.js.
  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const sessionStore = getStore('admin-sessions');
  await sessionStore.set(sessionToken, JSON.stringify({
    email: normalized,
    expiresAt: sessionExpiry,
  }));

  // Activity log (never throws).
  try { await recordLogin({ email: normalized, role: 'admin' }); } catch (e) {}

  const url = new URL(req.url);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const cookie = [
    `admin_session=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${24 * 60 * 60}`,
    'SameSite=Lax',
    ...(isLocal ? [] : ['Secure']),
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'Set-Cookie': cookie,
    },
  });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-bootstrap' };
