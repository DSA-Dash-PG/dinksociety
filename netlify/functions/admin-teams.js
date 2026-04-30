// netlify/functions/admin-teams.js
// Admin-only team management: list, update, and manage team details.
//
// GET                          → list all teams
// GET  ?id=<teamId>            → get single team detail
// PUT  ?id=<teamId>            → update team fields (name, colors, captain, co-captain, roster)
//      body: { name?, color?, secondaryColor?, captainPlayerId?, coCaptainPlayerId?, roster?, notes? }
// POST ?id=<teamId>&action=add-player → add a player to roster
//      body: { name, email?, gender?, dupr?, phone? }
// POST ?id=<teamId>&action=remove-player → remove a player
//      body: { playerId }
// POST ?id=<teamId>&action=set-captain → designate captain
//      body: { playerId }
// POST ?id=<teamId>&action=set-cocaptain → designate co-captain
//      body: { playerId }

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function generatePlayerId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'p_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  const url = new URL(req.url);
  const store = getStore('teams');
  const teamId = url.searchParams.get('id');

  // ========== GET — list all or single team ==========
  if (req.method === 'GET') {
    if (teamId) {
      const team = await store.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
      if (!team) return json({ error: 'Team not found' }, 404);
      return json({ team });
    }

    const { blobs } = await store.list({ prefix: 'team/' });
    const teams = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(Boolean);

    teams.sort((a, b) => (a.division || '').localeCompare(b.division || '') || (a.name || '').localeCompare(b.name || ''));
    return json({ teams });
  }

  // All write operations require a team ID
  if (!teamId) return json({ error: 'Team id required' }, 400);

  const teamKey = `team/${teamId}.json`;
  const team = await store.get(teamKey, { type: 'json' }).catch(() => null);
  if (!team) return json({ error: 'Team not found' }, 404);

  const now = new Date().toISOString();

  // ========== PUT — update team fields ==========
  if (req.method === 'PUT') {
    const body = await req.json();
    const allowed = ['name', 'color', 'secondaryColor', 'notes', 'division', 'divisionLabel'];

    for (const field of allowed) {
      if (field in body) {
        team[field] = body[field];
      }
    }

    // Handle roster replacement (full roster array)
    if (body.roster && Array.isArray(body.roster)) {
      team.roster = body.roster.map(p => ({
        id: p.id || generatePlayerId(),
        name: (p.name || '').trim(),
        email: p.email || null,
        phone: p.phone || null,
        gender: p.gender || '',
        dupr: p.dupr || null,
        isCaptain: !!p.isCaptain,
        isCoCaptain: !!p.isCoCaptain,
      })).filter(p => p.name);
    }

    // Update captain email if captain changed
    const captain = (team.roster || []).find(p => p.isCaptain);
    if (captain && captain.email) {
      team.captainEmail = captain.email;
    }

    team.updatedAt = now;
    team.updatedBy = admin.email;
    await store.setJSON(teamKey, team);
    return json({ ok: true, team });
  }

  // ========== POST — actions ==========
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');
    const body = await req.json();

    switch (action) {
      case 'add-player': {
        const roster = team.roster || [];
        if (roster.length >= 10) {
          return json({ error: 'Team is at max capacity (10 players)' }, 400);
        }
        const newPlayer = {
          id: generatePlayerId(),
          name: (body.name || '').trim(),
          email: body.email || null,
          phone: body.phone || null,
          gender: body.gender || '',
          dupr: body.dupr || null,
          isCaptain: false,
          isCoCaptain: false,
        };
        if (!newPlayer.name) return json({ error: 'Player name required' }, 400);
        roster.push(newPlayer);
        team.roster = roster;
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);
        return json({ ok: true, player: newPlayer, rosterCount: roster.length });
      }

      case 'remove-player': {
        const roster = team.roster || [];
        const idx = roster.findIndex(p => p.id === body.playerId);
        if (idx === -1) return json({ error: 'Player not found on team' }, 404);
        if (roster.length <= 4) {
          return json({ error: 'Cannot remove — team is at minimum roster size (4)' }, 400);
        }
        const [removed] = roster.splice(idx, 1);
        team.roster = roster;
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);
        return json({ ok: true, removed, rosterCount: roster.length });
      }

      case 'set-captain': {
        const roster = team.roster || [];
        const target = roster.find(p => p.id === body.playerId);
        if (!target) return json({ error: 'Player not found on team' }, 404);
        // Clear existing captain flags
        for (const p of roster) p.isCaptain = false;
        target.isCaptain = true;
        // Update captainEmail
        if (target.email) team.captainEmail = target.email;
        team.roster = roster;
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);
        return json({ ok: true, captain: target });
      }

      case 'set-cocaptain': {
        const roster = team.roster || [];
        const target = roster.find(p => p.id === body.playerId);
        if (!target) return json({ error: 'Player not found on team' }, 404);
        // Clear existing co-captain flags
        for (const p of roster) p.isCoCaptain = false;
        target.isCoCaptain = true;
        team.roster = roster;
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);
        return json({ ok: true, coCaptain: target });
      }

      case 'remove-cocaptain': {
        const roster = team.roster || [];
        for (const p of roster) p.isCoCaptain = false;
        team.roster = roster;
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/admin-teams' };
