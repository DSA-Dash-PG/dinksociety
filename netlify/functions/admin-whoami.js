// netlify/functions/admin-whoami.js
// Validates the admin session cookie and returns the admin's email.
// Returns 401 if no valid session.

import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  return new Response(JSON.stringify({ admin: true, email: admin.email }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
  });
};

export const config = { path: '/.netlify/functions/admin-whoami' };
