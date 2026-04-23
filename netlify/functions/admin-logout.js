// netlify/functions/admin-logout.js
// Clears the admin session cookie and deletes the session from Blobs.

import { getSessionToken, deleteSession, buildClearCookie } from './lib/admin-auth.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const sessionId = getSessionToken(req);
  if (sessionId) {
    await deleteSession(sessionId);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildClearCookie(),
    },
  });
};

export const config = { path: '/.netlify/functions/admin-logout' };
