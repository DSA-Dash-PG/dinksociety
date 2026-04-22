// netlify/functions/admin-whoami.js
// Returns the current admin user, or 401 if not signed in / not admin.

import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  return new Response(JSON.stringify({
    admin: true,
    email: admin.email,
    id: admin.id,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
  });
};

export const config = { path: '/.netlify/functions/admin-whoami' };
