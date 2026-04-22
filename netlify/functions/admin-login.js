// netlify/functions/admin-login.js
// Email/password sign-in via Supabase. Sets an HttpOnly session cookie
// on success. Validates admin status before issuing the cookie.

import { createClient } from '@supabase/supabase-js';
import { buildSessionCookie } from './lib/admin-auth.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const supabaseUrl = Netlify.env.get('SUPABASE_URL');
  const anonKey = Netlify.env.get('SUPABASE_ANON_KEY');
  const adminEmails = (Netlify.env.get('ADMIN_EMAILS') || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  if (!supabaseUrl || !anonKey) {
    return json({ error: 'Supabase not configured' }, 500);
  }

  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return json({ error: 'Email and password required' }, 400);
    }

    // Admin-gate BEFORE calling Supabase — don't leak existence of non-admin accounts
    const normalized = email.trim().toLowerCase();
    if (!adminEmails.includes(normalized)) {
      return json({ error: 'Invalid credentials' }, 401);
    }

    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data?.session) {
      return json({ error: 'Invalid credentials' }, 401);
    }

    const cookie = buildSessionCookie(data.session.access_token);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookie,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('admin-login error:', err);
    return json({ error: 'Sign-in failed' }, 500);
  }
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/.netlify/functions/admin-login' };
