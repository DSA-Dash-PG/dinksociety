// =============================================================
// GET /api/admin-link?token=xxx
//
// Consumes a one-time admin magic-link token. If valid and not
// expired, creates a session token, stores it in Blobs, sets it
// as an httpOnly cookie, and redirects to /admin.html.
//
// On failure, redirects to /admin.html?error=<reason>.
// =============================================================

import { getStore } from '@netlify/blobs';
import crypto from 'crypto';

export default async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const redirectBase = '/admin.html';

  if (!token) {
    return Response.redirect(new URL(`${redirectBase}?error=missing`, url.origin), 302);
  }

  try {
    const store = getStore('admin-magic-links');
    const raw = await store.get(token);

    if (!raw) {
      return Response.redirect(new URL(`${redirectBase}?error=invalid`, url.origin), 302);
    }

    const record = JSON.parse(raw);

    // Check expiry
    if (Date.now() > record.expiresAt) {
      await store.delete(token); // clean up
      return Response.redirect(new URL(`${redirectBase}?error=expired`, url.origin), 302);
    }

    // Check if already used
    if (record.used) {
      return Response.redirect(new URL(`${redirectBase}?error=invalid`, url.origin), 302);
    }

    // Mark as used
    await store.set(token, JSON.stringify({ ...record, used: true }));

    // Create a session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours

    const sessionStore = getStore('admin-sessions');
    await sessionStore.set(sessionToken, JSON.stringify({
      email: record.email,
      expiresAt: sessionExpiry,
    }));

    // Set the session cookie and redirect
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const cookie = [
      `admin_session=${sessionToken}`,
      'Path=/',
      'HttpOnly',
      `Max-Age=${24 * 60 * 60}`,
      'SameSite=Lax',
      ...(isLocal ? [] : ['Secure']),
    ].join('; ');

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectBase,
        'Set-Cookie': cookie,
      },
    });
  } catch (err) {
    console.error('admin-link error:', err);
    return Response.redirect(new URL(`${redirectBase}?error=server`, url.origin), 302);
  }
};
