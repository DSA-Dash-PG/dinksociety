// netlify/functions/captain-logout.js
// Deletes the server-side session AND clears the cookie.

import {
  buildClearCaptainCookie,
  getCaptainToken,
  deleteSession,
} from './lib/captain-auth.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const sessionId = getCaptainToken(req);
  if (sessionId) await deleteSession(sessionId);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildClearCaptainCookie(),
    },
  });
};

export const config = { path: '/.netlify/functions/captain-logout' };
