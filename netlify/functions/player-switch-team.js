// netlify/functions/player-switch-team.js
// POST { teamId } — switch the active player session to another team the
// signed-in player is rostered on. Re-mints the player session cookie for that
// team. Used by the team switcher in me.html when a player is on >1 team.

import {
  requirePlayer,
  unauthResponse,
  createPlayerSession,
  buildPlayerCookie,
  findAllPlayerTeamsByEmail,
} from './lib/player-auth.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const ctx = await requirePlayer(req);
  if (!ctx) return unauthResponse();

  const body = await req.json().catch(() => ({}));
  const teamId = body.teamId;
  if (!teamId) return json({ error: 'teamId required' }, 400);

  // No-op if already on this team.
  if (ctx.teamId === teamId) {
    return json({ ok: true, teamId, teamName: ctx.team?.name || null });
  }

  // Authorize against the player's real roster memberships (same email match +
  // test-season exclusion the switcher list uses).
  const mine = await findAllPlayerTeamsByEmail(ctx.session.email);
  const match = mine.find(m => m.teamId === teamId);
  if (!match) return json({ error: 'You are not on that team' }, 403);

  const sessionId = await createPlayerSession({
    playerId: match.playerId,
    teamId: match.teamId,
    email: ctx.session.email,
  });

  return new Response(JSON.stringify({
    ok: true,
    teamId: match.teamId,
    teamName: match.team.name,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'Set-Cookie': buildPlayerCookie(sessionId),
    },
  });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/player-switch-team' };
