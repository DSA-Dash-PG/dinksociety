// netlify/functions/admin-registration-move-player.js
// 'move-player' action, split from admin-registration-update.js.
// Moves a player between teams, then refreshes standings aggregates.
//
// POST { playerId, fromTeamId, toTeamId }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json } from './lib/registrations.js';
import { rebuildStandings } from './lib/standings.js';
import { circuitCode } from './lib/circuit.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body) {
  const teamStore = getStore('teams');
  const seasonStore = getStore('seasons');

  const { playerId, fromTeamId, toTeamId } = body;
  if (!playerId || !fromTeamId || !toTeamId) {
    return json({ error: 'playerId, fromTeamId, and toTeamId are all required' }, 400);
  }

  // Load source team
  const fromRaw = await teamStore.get(fromTeamId);
  if (!fromRaw) return json({ error: 'Source team not found' }, 404);
  const fromTeam = JSON.parse(fromRaw);

  // Load destination team
  const toRaw = await teamStore.get(toTeamId);
  if (!toRaw) return json({ error: 'Destination team not found' }, 404);
  const toTeam = JSON.parse(toRaw);

  // Find the player in source roster
  const roster = fromTeam.roster || [];
  const playerIdx = roster.findIndex((p) => p.id === playerId);
  if (playerIdx === -1) return json({ error: 'Player not found on source team' }, 404);

  // Check destination capacity
  const toRoster = toTeam.roster || [];
  const seasonData = toTeam.seasonId
    ? await seasonStore.get(toTeam.seasonId, { type: 'json' }).catch(() => null)
    : null;
  const maxRoster = seasonData?.maxRosterSize || 10;
  if (toRoster.length >= maxRoster) {
    return json({ error: `Destination team is at max capacity (${maxRoster} players)` }, 400);
  }

  // Move
  const [player] = roster.splice(playerIdx, 1);
  toRoster.push(player);

  fromTeam.roster = roster;
  fromTeam.updatedAt = new Date().toISOString();
  toTeam.roster = toRoster;
  toTeam.updatedAt = new Date().toISOString();

  await teamStore.set(fromTeamId, JSON.stringify(fromTeam));
  await teamStore.set(toTeamId, JSON.stringify(toTeam));

  // Refresh aggregates so the moved player shows under the right team
  // on public pages (team page leaders, leaderboard, etc.).
  const circuits = new Set([circuitCode(fromTeam.circuit), circuitCode(toTeam.circuit)]);
  for (const c of circuits) {
    if (c) rebuildStandings(c).catch(err =>
      console.error('rebuildStandings after move-player failed:', err));
  }

  return json({
    ok: true,
    player,
    from: { id: fromTeamId, name: fromTeam.name, rosterCount: roster.length },
    to: { id: toTeamId, name: toTeam.name, rosterCount: toRoster.length },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const body = await req.json();
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-move-player' };
