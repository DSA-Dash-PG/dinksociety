// =============================================================
// GET /api/admin-whoami
//
// Returns { admin: true, email } if the request has a valid
// admin session cookie. Returns 401 otherwise.
// =============================================================

import { verifyAdminSession } from './lib/auth.js';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const result = await verifyAdminSession(req);
  if (!result.valid) {
    return new Response('Unauthorized', { status: 401 });
  }

  return new Response(JSON.stringify({ admin: true, email: result.payload.email }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
