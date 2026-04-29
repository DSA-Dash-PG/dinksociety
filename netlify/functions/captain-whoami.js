// netlify/functions/captain-whoami.js
// Returns the captain's email and ALL teams they manage.
// The frontend uses this to populate the team switcher.

import { requireCaptain, unauthResponse } from './lib/captain-auth.js';

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  return new Response(JSON.stringify({
    captain: true,
    email: ctx.user.email,
    // Array of teams — frontend picks the active one
    teams: ctx.teams.map(t => ({
      id: t.id,
      name: t.name,
      division: t.division || null,
      divisionLabel: t.divisionLabel || null,
      circuit: t.circuit || 'I',
    })),
    // Backward compat: also send `team` as the first team
    team: ctx.teams[0] ? {
      id: ctx.teams[0].id,
      name: ctx.teams[0].name,
      division: ctx.teams[0].division,
      circuit: ctx.teams[0].circuit,
    } : null,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};

export const config = { path: '/.netlify/functions/captain-whoami' };
