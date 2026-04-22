// netlify/functions/admin-logout.js
// Clears the admin session cookie.

import { buildClearCookie } from './lib/admin-auth.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
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
