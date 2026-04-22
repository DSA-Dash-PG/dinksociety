// netlify/functions/captain-whoami.js
import { requireCaptain, unauthResponse } from './lib/captain-auth.js';

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();
  return new Response(JSON.stringify({
    captain: true,
    email: ctx.user.email,
    team: {
      id: ctx.team.id,
      name: ctx.team.name,
      division: ctx.team.division,
      circuit: ctx.team.circuit,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};

export const config = { path: '/.netlify/functions/captain-whoami' };
