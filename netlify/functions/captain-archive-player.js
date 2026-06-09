// netlify/functions/captain-archive-player.js
// Archive or restore a player on the captain's own team — a reversible
// alternative to deleting. Archived players drop out of the active roster and
// lineup pickers but keep their record and every game they've already played.
//
// POST ?action=archive   body: { playerId }
// POST ?action=restore   body: { playerId }

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { rebuildStandings } from './lib/standings.js';
import { logActivity } from './lib/activity-log.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  if (!['archive', 'restore'].includes(action)) return json({ error: 'action must be archive or restore' }, 400);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { playerId } = body;
  if (!playerId) return json({ error: 'playerId required' }, 400);

  const store = getStore('teams');
  const teamKey = `team/${ctx.team.id}.json`;
  const team = await store.get(teamKey, { type: 'json' }).catch(() => null);
  if (!team) return json({ error: 'Team not found' }, 404);

  const roster = team.roster || [];
  const player = roster.find(p => p.id === playerId);
  if (!player) return json({ error: 'Player not found on your roster' }, 404);

  // A captain can't archive themselves — leadership must transfer first.
  if (action === 'archive' && player.isCaptain) {
    return json({ error: 'The team captain cannot be archived. Reassign the captain role first.' }, 400);
  }

  if (action === 'archive') {
    player.archived = true;
    player.archivedAt = new Date().toISOString();
    player.archivedBy = ctx.captainEmail || ctx.email || 'captain';
    player.isCoCaptain = false; // an archived player can't hold a co-captain role
  } else {
    delete player.archived; delete player.archivedAt; delete player.archivedBy;
  }
  team.rosterUpdatedAt = new Date().toISOString();
  await store.setJSON(teamKey, team);

  await logActivity({
    type: action === 'archive' ? 'player.archived' : 'player.restored',
    actor: { email: ctx.captainEmail || ctx.email || null, role: 'captain' },
    team,
    player: { id: player.id, name: player.name },
    details: `${player.name} ${action === 'archive' ? 'archived' : 'restored'} on ${team.name}`,
  }).catch(() => {});

  // Refresh aggregates so active rosters/standings reflect the change.
  const circuit = circuitCode(team.circuit);
  if (circuit) rebuildStandings(circuit).catch(err => console.error('rebuildStandings after archive failed:', err));

  const activeCount = roster.filter(p => !p.archived).length;
  return json({ ok: true, action, player: { id: player.id, name: player.name, archived: !!player.archived }, activeCount });
};

export const config = { path: '/.netlify/functions/captain-archive-player' };
