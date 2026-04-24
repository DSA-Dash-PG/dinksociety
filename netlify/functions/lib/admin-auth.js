// =============================================================
// lib/admin-auth.js
//
// Validates admin sessions from the admin_session cookie.
// Reads the session from Netlify Blobs (admin-sessions store)
// and verifies the email is in ADMIN_EMAILS.
//
// Usage:
//   import { requireAdmin } from './lib/admin-auth.js';
//   const admin = await requireAdmin(req);
//   // admin = { email } or throws
// =============================================================

import { getStore } from '@netlify/blobs';

/**
 * Parse a specific cookie value from the Cookie header.
 */
function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Standard 401 response used by admin endpoints.
 */
export function unauthResponse(msg = 'Unauthorized') {
  return new Response(JSON.stringify({ error: msg }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Validate the admin session. Returns { email } or throws.
 */
export async function requireAdmin(req) {
  const token = getCookie(req, 'admin_session');
  if (!token) {
    throw new Error('No session');
  }

  const store = getStore('admin-sessions');
  const raw = await store.get(token);
  if (!raw) {
    throw new Error('Invalid session');
  }

  const session = JSON.parse(raw);

  // Check expiry
  if (Date.now() > session.expiresAt) {
    await store.delete(token); // clean up
    throw new Error('Session expired');
  }

  // Verify the email is still in the admin list
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(session.email)) {
    throw new Error('Not an admin');
  }

  return { email: session.email };
}
