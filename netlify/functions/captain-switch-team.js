// netlify/functions/captain-switch-team.js
// POST { teamId } — switch the active captain session to another team the
// signed-in captain leads. Re-mints the captain session cookie for that team.
// Used by the team switcher in captain.html when a captain leads >1 team.

import {
  requireCaptain,
  unauthResponse,
  leaderRole,
  createSession,
  buildCaptainCookie,
  getTeamById,
} from './lib/captain-auth.js';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const body = await req.json().catch(() => ({}));
  const teamId = body.teamId;
  if (!teamId) return json({ error: 'teamId required' }, 400);

  // No-op if already on this team.
  if (ctx.team?.id === teamId) {
    return json({ ok: true, teamId, teamName: ctx.team.name, role: ctx.user.role });
  }

  const team = await getTeamById(teamId);
  if (!team) return json({ error: 'Team not found' }, 404);

  // Authorize: the signed-in captain must actually lead the target team.
  const role = leaderRole(team, ctx.user.email);
  if (!role) return json({ error: 'You do not lead that team' }, 403);

  const sessionId = await createSession(team, ctx.user.email);

  return new Response(JSON.stringify({
    ok: true,
    role,
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

export const config = { path: '/.netlify/functions/captain-switch-team' };
