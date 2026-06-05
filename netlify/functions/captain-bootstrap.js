// netlify/functions/captain-bootstrap.js
// Single sign-on bridge. A logged-in PLAYER who is the captain or a co-captain of
// a team gets a captain session minted directly from their player session — no
// second magic-link login. The player portal (me.html) calls this when the user
// taps the Captain tab, then navigates to /captain.html.

import { requirePlayer, unauthResponse } from './lib/player-auth.js';
import {
  createSession,
  buildCaptainCookie,
  findTeamByLeaderEmail,
} from './lib/captain-auth.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Must already be signed in as a player.
  const ctx = await requirePlayer(req);
  if (!ctx) return unauthResponse();

  const email = ctx.session.email;
  const found = await findTeamByLeaderEmail(email);
  if (!found) {
    // Authenticated, but not a captain or co-captain of any team.
    return json({ error: 'Not a captain or co-captain' }, 403);
  }

  const sessionId = await createSession(found.team, email);

  return new Response(JSON.stringify({
    ok: true,
    role: found.role,            // 'captain' | 'cocaptain'
    teamId: found.team.id,
    teamName: found.team.name,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'Set-Cookie': buildCaptainCookie(sessionId),
    },
  });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-bootstrap' };
