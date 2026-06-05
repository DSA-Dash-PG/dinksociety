// netlify/functions/captain-bootstrap.js
// Single sign-on bridge. A logged-in PLAYER who is the captain or a co-captain of
// a team gets a captain session minted directly from their player session — no
// second magic-link login. The player portal (me.html) calls this when the user
// taps the Captain tab, then navigates to /captain.html.

import { requirePlayer, unauthResponse } from './lib/player-auth.js';
import {
  createSession,
  buildCaptainCookie,
  leaderRole,
} from './lib/captain-auth.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Must already be signed in as a player.
  const ctx = await requirePlayer(req);
  if (!ctx) return unauthResponse();

  // Bind the captain session to the EXACT team this player is on — the same team
  // the player portal already shows them. We must NOT scan all teams by email and
  // grab the first captain match: a user who leads more than one team (e.g. a real
  // season team plus a seeded test-season team) could otherwise be dropped into the
  // wrong team's captain portal. Their saved lineups would then look "missing"
  // because drafts are keyed by team id (lineup/<matchId>/<teamId>.json), and the
  // wrong team has no draft. Resolution order across seasons isn't even stable, so
  // the same account could land on a different team from one tap to the next.
  const team = ctx.team;
  const email = ctx.session.email;
  const role = leaderRole(team, email);
  if (!role) {
    // Authenticated as a player, but not a leader of their own team.
    return json({ error: 'Not a captain or co-captain of your team' }, 403);
  }

  const sessionId = await createSession(team, email);

  return new Response(JSON.stringify({
    ok: true,
    role,                        // 'captain' | 'cocaptain'
    teamId: team.id,
    teamName: team.name,
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
