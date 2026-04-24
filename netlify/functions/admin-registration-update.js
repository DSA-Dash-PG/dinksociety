// =============================================================
// /api/admin-registration-update
//
// Manage individual registrations: approve, reject, move to
// different division, move players between teams.
//
// POST with { action, ... }
//
// Actions:
//   reject     { id, reason }          → marks registration as rejected
//   reinstate  { id }                  → marks rejected registration back to confirmed
//   move-division { id, newDivision }  → moves a team/agent to a different division
//   move-player   { playerId, fromTeamId, toTeamId } → moves a player between teams
//   remove-player { playerId, teamId } → removes a player from a team
// =============================================================

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    await requireAdmin(req);
  } catch {
    return unauthResponse();
  }

  const body = await req.json();
  const { action } = body;

  const regStore = getStore('registrations');
  const teamStore = getStore('teams');

  switch (action) {
    // ─── Reject a registration ───
    case 'reject': {
      const { id, reason } = body;
      if (!id) return json({ error: 'Registration id required' }, 400);

      const raw = await regStore.get(id);
      if (!raw) return json({ error: 'Registration not found' }, 404);

      const reg = JSON.parse(raw);
      reg.status = 'rejected';
      reg.rejectedAt = new Date().toISOString();
      reg.rejectReason = reason || '';
      await regStore.set(id, JSON.stringify(reg));

      return json({ ok: true, registration: reg });
    }

    // ─── Reinstate a rejected registration ───
    case 'reinstate': {
      const { id } = body;
      if (!id) return json({ error: 'Registration id required' }, 400);

      const raw = await regStore.get(id);
      if (!raw) return json({ error: 'Registration not found' }, 404);

      const reg = JSON.parse(raw);
      if (reg.status !== 'rejected') {
        return json({ error: 'Only rejected registrations can be reinstated' }, 400);
      }
      reg.status = 'confirmed';
      delete reg.rejectedAt;
      delete reg.rejectReason;
      await regStore.set(id, JSON.stringify(reg));

      return json({ ok: true, registration: reg });
    }

    // ─── Move to a different division ───
    case 'move-division': {
      const { id, newDivision } = body;
      if (!id || !newDivision) return json({ error: 'Registration id and newDivision required' }, 400);

      const raw = await regStore.get(id);
      if (!raw) return json({ error: 'Registration not found' }, 404);

      const reg = JSON.parse(raw);
      const oldDivision = reg.division;
      reg.division = newDivision;
      reg.updatedAt = new Date().toISOString();
      await regStore.set(id, JSON.stringify(reg));

      // If there's a corresponding team record, update it too
      if (reg.path === 'team' && reg.teamId) {
        const teamRaw = await teamStore.get(reg.teamId);
        if (teamRaw) {
          const team = JSON.parse(teamRaw);
          team.division = newDivision;
          team.updatedAt = new Date().toISOString();
          await teamStore.set(reg.teamId, JSON.stringify(team));
        }
      }

      return json({ ok: true, registration: reg, moved: { from: oldDivision, to: newDivision } });
    }

    // ─── Move a player between teams ───
    case 'move-player': {
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
      if (toRoster.length >= 10) {
        return json({ error: 'Destination team is at max capacity (10 players)' }, 400);
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

      return json({
        ok: true,
        player,
        from: { id: fromTeamId, name: fromTeam.name, rosterCount: roster.length },
        to: { id: toTeamId, name: toTeam.name, rosterCount: toRoster.length },
      });
    }

    // ─── Remove a player from a team ───
    case 'remove-player': {
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

      return json({ ok: true, removed, rosterCount: roster.length });
    }

    default:
      return json({ error: `Unknown action: ${action}` }, 400);
  }
};
