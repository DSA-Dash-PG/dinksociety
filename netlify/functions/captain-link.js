// netlify/functions/captain-link.js
// Consumes a magic-link token from the email. On success: creates a session,
// sets the cookie, redirects to /captain.html. On failure: redirects with an error.

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

    // Verify the captain still owns the team (captainEmail hasn't changed)
    const team = await getTeamById(consumed.teamId);
    if (!team || (team.captainEmail || '').toLowerCase() !== consumed.email) {
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
