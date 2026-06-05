// netlify/functions/player-link.js
// Magic-link callback: consume token → create player session → redirect to /me.html.

import { consumePlayerToken, createPlayerSession, buildPlayerCookie } from './lib/player-auth.js';

export default async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const siteUrl = Netlify.env.get('SITE_URL') || 'https://dinksociety.netlify.app';
  const redirect = (path) => new Response(null, { status: 302, headers: { Location: new URL(path, siteUrl).toString() } });

  if (!token) return redirect('/me.html?error=missing');
  try {
    const consumed = await consumePlayerToken(token);
    if (!consumed) return redirect('/me.html?error=invalid');
    const sessionId = await createPlayerSession({ playerId: consumed.playerId, teamId: consumed.teamId, email: consumed.email });
    return new Response(null, {
      status: 302,
      headers: { Location: new URL('/me.html', siteUrl).toString(), 'Set-Cookie': buildPlayerCookie(sessionId) },
    });
  } catch (err) {
    console.error('player-link error:', err);
    return redirect('/me.html?error=server');
  }
};

export const config = { path: '/.netlify/functions/player-link' };
