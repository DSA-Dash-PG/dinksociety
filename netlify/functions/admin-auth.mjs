// =============================================================
// GET /api/admin-auth?token=xxx
// Consumes a one-time magic-link token, creates a session in
// Netlify Blobs, sets an HttpOnly cookie, and redirects to
// /admin.html. On failure, redirects with ?error=<code>.
// =============================================================

import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'ds_admin_session';

export default async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const redirect = (error) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin.html${error ? `?error=${error}` : ''}` },
    });

  if (!token) return redirect('missing');

  try {
    const tokenStore = getStore('admin-tokens');
    let payload;
    try {
      payload = await tokenStore.get(token, { type: 'json' });
    } catch {
      payload = null;
    }

    if (!payload) return redirect('invalid');

    // Delete token immediately (one-time use)
    await tokenStore.delete(token);

    // Check expiry
    if (Date.now() > payload.expiresAt) return redirect('expired');

    // Create session
    const sessionId = crypto.randomBytes(32).toString('hex');
    const sessionStore = getStore('admin-sessions');
    await sessionStore.setJSON(sessionId, {
      email: payload.email,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    // Set cookie and redirect to admin shell
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const cookie = [
      `${COOKIE_NAME}=${sessionId}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      ...(isLocal ? [] : ['Secure']),
    ].join('; ');

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/admin.html',
        'Set-Cookie': cookie,
      },
    });
  } catch (err) {
    console.error('admin-auth error:', err);
    return redirect('server');
  }
};
