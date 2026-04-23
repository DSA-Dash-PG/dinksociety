// netlify/functions/admin-link.js
// Consumes a one-time magic-link token, creates a session, sets an
// HttpOnly cookie, and redirects to /admin.html.
// On failure, redirects with ?error=<code>.

import { consumeMagicToken, createSession, buildSessionCookie } from './lib/admin-auth.js';

export default async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');

  const redirect = (error) =>
    new Response(null, {
      status: 302,
      headers: { Location: `/admin.html${error ? `?error=${error}` : ''}` },
    });

  if (!token) return redirect('missing');

  try {
    const result = await consumeMagicToken(token);

    if (!result) return redirect('invalid');

    // Verify the email is still in the admin list
    const adminEmails = (Netlify.env.get('ADMIN_EMAILS') || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    if (!adminEmails.includes(result.email)) return redirect('invalid');

    // Create session and set cookie
    const sessionId = await createSession(result.email);
    const cookie = buildSessionCookie(sessionId);

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/admin.html',
        'Set-Cookie': cookie,
      },
    });
  } catch (err) {
    console.error('admin-link error:', err);
    return redirect('server');
  }
};

export const config = { path: '/.netlify/functions/admin-link' };
