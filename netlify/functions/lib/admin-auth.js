// netlify/functions/lib/admin-auth.js
// Shared admin auth helper. Validates a Supabase session from the incoming
// request and returns the user if they're an admin, null otherwise.
//
// Required env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   — service role key (server-side only, never in frontend)
//   ADMIN_EMAILS                — comma-separated list of admin email addresses

import { createClient } from '@supabase/supabase-js';

const COOKIE_NAME = 'ds_admin_session';

/**
 * Get the admin user from a request, or null if not authenticated / not admin.
 * Call this at the top of any admin function.
 */
export async function requireAdmin(req) {
  const token = getSessionToken(req);
  if (!token) return null;

  const supabaseUrl = Netlify.env.get('SUPABASE_URL');
  const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const adminEmails = (Netlify.env.get('ADMIN_EMAILS') || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  if (!supabaseUrl || !serviceKey) {
    console.error('Supabase env vars missing');
    return null;
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;

    const email = (data.user.email || '').toLowerCase();
    if (!adminEmails.includes(email)) return null;

    return { id: data.user.id, email: data.user.email };
  } catch (err) {
    console.error('Auth check failed:', err);
    return null;
  }
}

/** Extract session token from cookies */
export function getSessionToken(req) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Build a Set-Cookie header value for the session */
export function buildSessionCookie(token, { maxAge = 60 * 60 * 24 * 7 } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  return parts.join('; ');
}

/** Build a Set-Cookie header value that clears the session */
export function buildClearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** Standard unauth response */
export function unauthResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
