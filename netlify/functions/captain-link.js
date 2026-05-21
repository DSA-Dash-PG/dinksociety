// netlify/functions/captain-link.js
// Handles magic-link callback. Consumes the one-time token, loads the
// captain's team, creates a session, and redirects to /captain.html
// with a session cookie.

import {
  consumeMagicToken,
  createSession,
  buildCaptainCookie,
  getTeamById,
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

    // The magic token carries the captain's team — load it.
    const team = await getTeamById(consumed.teamId);
    if (!team) {
      return redirect('/captain.html?error=expired');
    }

    const sessionId = await createSession(team, consumed.email);

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
