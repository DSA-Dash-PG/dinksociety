// netlify/functions/captain-set-sub.js
// A captain (or co-captain) marks a rostered player as a SUB (backup) or clears
// it. Subs are excluded from the automatic availability reminders.
//
//   POST  { playerId, isSub: true|false }
//
// This is intentionally NOT gated by the Week-2 roster lock: designating a sub
// only flips a reminder flag, it doesn't add or remove anyone from the roster, so
// captains can still manage subs all season. The captain/co-captain can't be a
// sub (they run the team).

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { logActivity } from './lib/activity-log.js';
import { circuitCode } from './lib/circuit.js';

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.json().catch(() => ({}));
  const playerId = body.playerId;
  const isSub = !!body.isSub;
  if (!playerId) return json({ error: 'playerId required' }, 400);

  const store = getStore('teams');
  const teamKey = `team/${ctx.team.id}.json`;
  const team = await store.get(teamKey, { type: 'json' }).catch(() => null);
  if (!team) return json({ error: 'Team not found' }, 404);

  const target = (team.roster || []).find(p => p.id === playerId);
  if (!target) return json({ error: 'Player not on your roster' }, 400);
  if (isSub && (target.isCaptain || target.isCoCaptain)) {
    return json({ error: 'The captain and co-captain can’t be marked as subs.' }, 400);
  }

  if (isSub) target.isSub = true; else delete target.isSub;
  team.updatedAt = new Date().toISOString();
  await store.setJSON(teamKey, team);

  await logActivity({
    type: 'roster.sub-set',
    actor: { email: ctx.user.email, role: ctx.user.role },
    team, circuit: circuitCode(team.circuit),
    player: { id: target.id, name: target.name },
    details: `${team.name}: ${target.name} ${isSub ? 'marked as a sub' : 'is no longer a sub'}`,
  }).catch(() => {});

  return json({ ok: true, playerId, isSub: !!target.isSub });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-set-sub' };
