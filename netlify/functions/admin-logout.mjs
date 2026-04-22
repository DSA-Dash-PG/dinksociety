// =============================================================
// POST /api/admin-logout
// Deletes the session from the blob store and clears the cookie.
// =============================================================

import { getStore } from '@netlify/blobs';

const COOKIE_NAME = 'ds_admin_session';

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  });
  return cookies;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const cookies = parseCookies(req.headers.get('cookie'));
    const sessionId = cookies[COOKIE_NAME];

    if (sessionId) {
      const store = getStore('admin-sessions');
      try {
        await store.delete(sessionId);
      } catch {
        // ignore — session may already be gone
      }
    }

    // Clear the cookie
    const clearCookie = [
      `${COOKIE_NAME}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ].join('; ');

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': clearCookie,
      },
    });
  } catch (err) {
    console.error('admin-logout error:', err);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
