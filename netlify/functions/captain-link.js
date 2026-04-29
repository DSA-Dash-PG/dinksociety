// netlify/functions/captain-link.js
// Handles magic-link callback. Consumes the one-time token, creates a
// session (tied to the captain's email, not a specific team), and
// redirects to /captain.html with a session cookie.

import {
  consumeMagicToken,
  createSession,
  buildCaptainCookie,
  findTeamsByCaptainEmail,
} from './lib/captain-auth.js';

export default async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const siteUrl = Netlify.env.get('SITE_URL') || 'https://dinksociety.netlify.app';

  const redirect = (path) => {
    const target = new URL(path, siteUrl).toString();
    return new Response(null, { status: 302, headers: { Location: target } });
  };

  if (!token) return redirect('/captain.html?error=missing');

  try {
    const consumed = await consumeMagicToken(token);
    if (!consumed) return redirect('/captain.html?error=invalid');

    // Verify the captain still has at least one team
    const teams = await findTeamsByCaptainEmail(consumed.email);
    if (!teams.length) {
      return redirect('/captain.html?error=expired');
    }

    // Session is tied to the email — captain picks their team in the UI
    const sessionId = await createSession(consumed.email);

    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL('/captain.html', siteUrl).toString(),
        'Set-Cookie': buildCaptainCookie(sessionId),
      },
    });
  } catch (err) {
    console.error('captain-link error:', err);
    return redirect('/captain.html?error=server');
  }
};

export const config = { path: '/.netlify/functions/captain-link' };
