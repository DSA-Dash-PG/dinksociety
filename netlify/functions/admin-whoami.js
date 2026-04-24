// =============================================================
// GET /api/admin-whoami
//
// Returns { admin: true, email } if the request has a valid
// admin session cookie. Returns 401 otherwise.
// =============================================================

import { requireAdmin } from './lib/admin-auth.js';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const admin = await requireAdmin(req);
    return new Response(JSON.stringify({ admin: true, email: admin.email }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }
};
