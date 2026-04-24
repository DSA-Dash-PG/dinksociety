// =============================================================
// POST /api/admin-logout
//
// Clears the admin session cookie and removes the session
// from Netlify Blobs.
// =============================================================

import { getStore } from '@netlify/blobs';

function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const token = getCookie(req, 'admin_session');
    if (token) {
      const store = getStore('admin-sessions');
      await store.delete(token);
    }
  } catch (err) {
    console.error('admin-logout cleanup error:', err);
  }

  const isLocal = new URL(req.url).hostname === 'localhost';
  const cookie = [
    'admin_session=',
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    'SameSite=Lax',
    ...(isLocal ? [] : ['Secure']),
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
};
