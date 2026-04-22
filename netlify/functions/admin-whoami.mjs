// =============================================================
// GET /api/admin-whoami
// Reads the ds_admin_session cookie, validates it against the
// admin-sessions blob store, and returns { admin: true, email }.
// Returns 401 if no valid session.
// =============================================================

import { getStore } from '@netlify/blobs';

const COOKIE_NAME = 'ds_admin_session';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function parseCookies(header) {
  const cookies = {};
  (header || '').split(';').forEach((pair) => {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key.trim()] = rest.join('=').trim();
  });
  return cookies;
}

export default async (req) => {
  const unauth = () =>
    new Response(JSON.stringify({ admin: false }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const cookies = parseCookies(req.headers.get('cookie'));
    const sessionId = cookies[COOKIE_NAME];
    if (!sessionId) return unauth();

    const store = getStore('admin-sessions');
    let session;
    try {
      session = await store.get(sessionId, { type: 'json' });
    } catch {
      session = null;
    }

    if (!session) return unauth();

    // Check expiry
    if (Date.now() > session.expiresAt) {
      await store.delete(sessionId);
      return unauth();
    }

    // Double-check the email is still in the admin list
    if (!ADMIN_EMAILS.includes(session.email)) {
      await store.delete(sessionId);
      return unauth();
    }

    return new Response(JSON.stringify({ admin: true, email: session.email }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('admin-whoami error:', err);
    return unauth();
  }
};
