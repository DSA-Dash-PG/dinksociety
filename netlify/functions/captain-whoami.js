// netlify/functions/captain-whoami.js
// Returns the captain's email and ALL teams they manage.
// The frontend uses this to populate the team switcher.

import { requireCaptain, unauthResponse, findAllLeaderTeamsByEmail } from './lib/captain-auth.js';

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const t = ctx.team;
  const teamEntry = t ? {
    id: t.id,
    name: t.name,
    division: t.division || null,
    divisionLabel: t.divisionLabel || null,
    circuit: t.circuit || 'I',
    seasonId: t.seasonId || null,
    emoji: t.emoji || '',
    photo: t.photo || null,
    role: ctx.user.role,
  } : null;

  // Every team this captain leads, for the switcher.
  const all = await findAllLeaderTeamsByEmail(ctx.user.email);
  const teams = all.map(({ team, role }) => ({
    id: team.id,
    name: team.name,
    division: team.division || null,
    divisionLabel: team.divisionLabel || null,
    circuit: team.circuit || 'I',
    seasonId: team.seasonId || null,
    emoji: team.emoji || '',
    photo: team.photo || null,
    role,
  }));

  // Make sure the currently-active team is always present in the list, even if
  // it was filtered out (e.g. a test-season team the captain is QA-ing).
  if (teamEntry && !teams.some(x => x.id === teamEntry.id)) {
    teams.unshift(teamEntry);
  }

  return new Response(JSON.stringify({
    captain: true,
    email: ctx.user.email,
    teams,
    team: teamEntry,
    currentTeamId: teamEntry ? teamEntry.id : null,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};

export const config = { path: '/.netlify/functions/captain-whoami' };
