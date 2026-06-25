// netlify/functions/player-link.js
// Magic-link callback: consume token → create player session → redirect to /me.html.

import { consumePlayerToken, createPlayerSession, buildPlayerCookie } from './lib/player-auth.js';
import { getStore } from '@netlify/blobs';
import { recordLogin } from './lib/activity-log.js';

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

    // Activity log: who's actually using the site (never throws, test teams skipped).
    // Lite ladder-only accounts have no team (teamId null) — skip the team lookup.
    const team = consumed.teamId ? await getStore('teams').get(`team/${consumed.teamId}.json`, { type: 'json' }).catch(() => null) : null;
    const rosterEntry = (team?.roster || []).find(p => p.id === consumed.playerId);
    await recordLogin({ email: consumed.email, role: 'player', name: rosterEntry?.name || null, team, playerId: consumed.playerId });

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
