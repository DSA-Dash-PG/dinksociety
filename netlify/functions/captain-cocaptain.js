// netlify/functions/captain-cocaptain.js
// Lets the TEAM CAPTAIN promote/demote co-captains from the captain portal,
// so they can hand off lineup + score entry when they can't make a match.
//
// POST ?action=add     body: { playerId }   → grant co-captain
// POST ?action=remove  body: { playerId }   → revoke co-captain
//
// Rules:
//   - Only the captain (not a co-captain) can manage co-captains.
//   - Up to MAX_COCAPTAINS co-captains per team.
//   - The captain can't co-captain themselves; the target must be on the roster.
// Co-captains already get a full captain session (lib/captain-auth leaderRole),
// so once promoted they can set lineups and enter/confirm scores.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { logActivity } from './lib/activity-log.js';

const MAX_COCAPTAINS = 2;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  // Only the head captain manages co-captains.
  if (ctx.user.role !== 'captain') {
    return json({ error: 'Only the team captain can add or remove co-captains.' }, 403);
  }

  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  if (!['add', 'remove'].includes(action)) {
    return json({ error: 'action must be add or remove' }, 400);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const playerId = body.playerId;
  if (!playerId) return json({ error: 'playerId required' }, 400);

  const store = getStore('teams');
  const teamKey = `team/${ctx.team.id}.json`;

  // Re-read the team (avoid clobbering a concurrent roster edit).
  const team = await store.get(teamKey, { type: 'json' }).catch(() => null);
  if (!team) return json({ error: 'Team not found' }, 404);
  const roster = team.roster || [];

  const target = roster.find(p => p.id === playerId);
  if (!target) return json({ error: 'That player is not on your roster.' }, 404);
  if (target.isCaptain) return json({ error: 'The captain is already running the team.' }, 400);

  if (action === 'add') {
    if (target.isCoCaptain) return json({ error: `${target.name} is already a co-captain.` }, 409);
    const current = roster.filter(p => p.isCoCaptain).length;
    if (current >= MAX_COCAPTAINS) {
      return json({ error: `You can have up to ${MAX_COCAPTAINS} co-captains. Remove one first.` }, 409);
    }
    target.isCoCaptain = true;
  } else {
    if (!target.isCoCaptain) return json({ error: `${target.name} isn't a co-captain.` }, 409);
    target.isCoCaptain = false;
  }

  team.roster = roster;
  team.updatedAt = new Date().toISOString();
  team.updatedBy = ctx.user.email;
  await store.setJSON(teamKey, team);

  await logActivity({
    type: action === 'add' ? 'cocaptain.set' : 'cocaptain.removed',
    actor: { email: ctx.user.email, role: 'captain' },
    team,
    player: { id: target.id, name: target.name },
    details: action === 'add'
      ? `${target.name} made co-captain of ${team.name} by the captain`
      : `${target.name} removed as co-captain of ${team.name} by the captain`,
  });

  return json({
    ok: true,
    playerId: target.id,
    isCoCaptain: !!target.isCoCaptain,
    coCaptainCount: roster.filter(p => p.isCoCaptain).length,
    maxCoCaptains: MAX_COCAPTAINS,
  });
};

export const config = { path: '/.netlify/functions/captain-cocaptain' };
