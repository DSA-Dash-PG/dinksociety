// netlify/functions/admin-registration-remove-player.js
// 'remove-player' action, split from admin-registration-update.js.
// Removes a player from a team roster (min roster size enforced), then
// refreshes standings aggregates.
//
// POST { playerId, teamId }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json } from './lib/registrations.js';
import { rebuildStandings } from './lib/standings.js';
import { circuitCode } from './lib/circuit.js';
import { logActivity } from './lib/activity-log.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body, admin = null) {
  const teamStore = getStore('teams');

  const { playerId, teamId } = body;
  if (!playerId || !teamId) return json({ error: 'playerId and teamId required' }, 400);

  const teamRaw = await teamStore.get(teamId);
  if (!teamRaw) return json({ error: 'Team not found' }, 404);
  const team = JSON.parse(teamRaw);

  const roster = team.roster || [];
  const playerIdx = roster.findIndex((p) => p.id === playerId);
  if (playerIdx === -1) return json({ error: 'Player not found on team' }, 404);

  // Don't allow removing below minimum
  if (roster.length <= 4) {
    return json({ error: 'Cannot remove — team is already at minimum roster size (4)' }, 400);
  }

  const [removed] = roster.splice(playerIdx, 1);
  team.roster = roster;
  team.updatedAt = new Date().toISOString();
  await teamStore.set(teamId, JSON.stringify(team));

  await logActivity({
    type: 'player.removed',
    actor: { email: admin?.email || null, role: 'admin' },
    team,
    player: { id: removed.id, name: removed.name },
    details: `${removed.name} removed from ${team.name}`,
  });

  // Refresh aggregates so the removed player stops showing on public pages.
  const circuit = circuitCode(team.circuit);
  if (circuit) rebuildStandings(circuit).catch(err =>
    console.error('rebuildStandings after remove-player failed:', err));

  return json({ ok: true, removed, rosterCount: roster.length });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const body = await req.json();
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-remove-player' };
