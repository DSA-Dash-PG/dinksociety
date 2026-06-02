// netlify/functions/captain-whoami.js
// Returns the captain's email and ALL teams they manage.
// The frontend uses this to populate the team switcher.

import { requireCaptain, unauthResponse } from './lib/captain-auth.js';

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
  } : null;

  return new Response(JSON.stringify({
    captain: true,
    email: ctx.user.email,
    teams: teamEntry ? [teamEntry] : [],
    team: teamEntry,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};

export const config = { path: '/.netlify/functions/captain-whoami' };
