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
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail, normalizePhone, findContactCollisions } from './lib/identity.js';
import { circuitCode } from './lib/circuit.js';
import { rebuildStandings } from './lib/standings.js';
import { logActivity } from './lib/activity-log.js';

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
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);
  const store = getStore('teams');
  const seasonStore = getStore('seasons');
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
    const oldName = team.name;
    const allowed = ['name', 'emoji', 'color', 'secondaryColor', 'notes', 'division', 'divisionLabel'];

    for (const field of allowed) {
      if (field in body) {
        team[field] = body[field];
      }
    }

    // Handle roster replacement (full roster array)
    if (body.roster && Array.isArray(body.roster)) {
      // Archive state is owned by the archive/restore actions — preserve it from
      // the stored roster by id so a plain roster save can't flip or wipe it.
      const prevById = new Map((team.roster || []).map(x => [x.id, x]));
      team.roster = body.roster.map(p => {
        const prev = prevById.get(p.id) || null;
        // Bio profile: merge any admin-supplied fields onto the stored profile
        // (admin edits apply live). When the payload omits profile, keep prev's.
        const incomingProfile = p.profile && typeof p.profile === 'object' ? p.profile : null;
        const mergedProfile = (incomingProfile || prev?.profile)
          ? { ...(prev?.profile || {}), ...(incomingProfile || {}) }
          : null;
        return {
          id: p.id || generatePlayerId(),
          name: (p.name || '').trim(),
          email: p.email || null,
          phone: p.phone || null,
          // Keep normalized keys in sync so player magic-link login keeps working.
          normalizedEmail: normalizeEmail(p.email),
          normalizedPhone: normalizePhone(p.phone),
          gender: p.gender || '',
          dupr: p.dupr || null,
          isCaptain: !!p.isCaptain,
          isCoCaptain: !!p.isCoCaptain,
          // Profile bio / pending edits / photo stamp are owned by the profile
          // endpoints — preserve (or live-merge) them so a team save can't wipe them.
          ...(mergedProfile ? { profile: mergedProfile } : {}),
          ...(prev?.pendingProfile ? { pendingProfile: prev.pendingProfile } : {}),
          ...(prev?.photo ? { photo: prev.photo } : {}),
          ...(prev?.archived ? { archived: true, archivedAt: prev.archivedAt || null, archivedBy: prev.archivedBy || null } : {}),
        };
      }).filter(p => p.name);
    }

    // Captain is anchored to captainEmail (the login identity). Adding or editing
    // players must NEVER silently reassign it. An explicit isCaptain flag (admin
    // clicked "Captain") wins; otherwise keep the existing captain and re-sync the
    // flag + name to them so the roster stays consistent.
    {
      const roster = team.roster || [];
      const flagged = roster.find(p => p.isCaptain && p.email);
      const capEmail = (team.captainEmail || '').toLowerCase();
      if (flagged) {
        team.captainEmail = flagged.email;
        team.captainName = flagged.name || team.captainName || '';
        team.captain = team.captainName;
        roster.forEach(p => { p.isCaptain = (p === flagged); });
      } else if (capEmail) {
        const capEntry = roster.find(p => (p.email || '').toLowerCase() === capEmail);
        roster.forEach(p => { p.isCaptain = !!(capEntry && p === capEntry); });
        if (capEntry) { team.captainName = capEntry.name; team.captain = capEntry.name; }
      }
    }

    team.updatedAt = now;
    team.updatedBy = admin.email;
    await store.setJSON(teamKey, team);

    await logActivity({
      type: body.roster ? 'roster.replaced' : 'team.updated',
      actor: { email: admin.email, role: 'admin' },
      team,
      details: ('name' in body && team.name !== oldName)
        ? `Team renamed "${oldName}" → "${team.name}"`
        : body.roster
          ? `Roster replaced (${(team.roster || []).length} players)`
          : `Team settings updated (${Object.keys(body).filter(k => allowed.includes(k)).join(', ') || 'fields'})`,
    });

    // The team blob is the source of truth for the name, but the name is also
    // SNAPSHOTTED into schedule matches, score records, and lineup records when
    // those are created. On rename, push the new name into every copy so the
    // whole site updates — otherwise public schedule/standings keep the old name.
    if ('name' in body && team.name !== oldName) {
      try {
        await propagateTeamRename(team);
      } catch (err) {
        console.error('Team rename propagation failed:', err);
        return json({ ok: true, team, warning: 'Team saved, but updating the name on existing schedule/score records failed — regenerate or retry.' });
      }
    } else if (body.roster && Array.isArray(body.roster)) {
      // Roster replaced → refresh the pre-computed standings/player-stats
      // aggregates so removed players don't linger on public pages (team page
      // "Team Leaders", leaderboard, etc.). Rename path above already rebuilds.
      rebuildStandings(circuitCode(team.circuit)).catch(err =>
        console.error('rebuildStandings after roster update failed:', err));
    }
    return json({ ok: true, team });
  }

  // ========== POST — actions ==========
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');
    const body = await req.json();

    switch (action) {
      case 'add-player': {
        const roster = team.roster || [];
        const seasonData = team.seasonId
          ? await seasonStore.get(team.seasonId, { type: 'json' }).catch(() => null)
          : null;
        const maxRoster = seasonData?.maxRosterSize || 12;
        if (roster.length >= maxRoster) {
          return json({ error: `Team is at max capacity (${maxRoster} players)` }, 400);
        }
        const newPlayer = {
          id: generatePlayerId(),
          name: (body.name || '').trim(),
          email: body.email || null,
          phone: body.phone || null,
          normalizedEmail: normalizeEmail(body.email),
          normalizedPhone: normalizePhone(body.phone),
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
        await logActivity({
          type: 'player.added',
          actor: { email: admin.email, role: 'admin' },
          team,
          player: { id: newPlayer.id, name: newPlayer.name },
          details: `${newPlayer.name} added to ${team.name}${newPlayer.email ? ` (${newPlayer.email})` : ''}`,
        });
        // Refresh aggregates so the new player appears on public pages.
        rebuildStandings(circuitCode(team.circuit)).catch(err =>
          console.error('rebuildStandings after add-player failed:', err));
        // Surface (don't block) any contact collision the new player created.
        const duplicateWarnings = findContactCollisions(roster);
        return json({ ok: true, player: newPlayer, rosterCount: roster.length, duplicateWarnings });
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
        await logActivity({
          type: 'player.removed',
          actor: { email: admin.email, role: 'admin' },
          team,
          player: { id: removed.id, name: removed.name },
          details: `${removed.name} removed from ${team.name}`,
        });
        // Refresh aggregates so the removed player stops showing on public pages.
        rebuildStandings(circuitCode(team.circuit)).catch(err =>
          console.error('rebuildStandings after remove-player failed:', err));
        return json({ ok: true, removed, rosterCount: roster.length });
      }

      case 'archive-player':
      case 'restore-player': {
        const roster = team.roster || [];
        const target = roster.find(p => p.id === body.playerId);
        if (!target) return json({ error: 'Player not found on team' }, 404);
        const archiving = action === 'archive-player';
        if (archiving && target.isCaptain) {
          return json({ error: 'The team captain cannot be archived. Reassign the captain role first.' }, 400);
        }
        if (archiving) {
          target.archived = true;
          target.archivedAt = now;
          target.archivedBy = admin.email;
          target.isCoCaptain = false;
        } else {
          delete target.archived; delete target.archivedAt; delete target.archivedBy;
        }
        team.roster = roster;
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);
        await logActivity({
          type: archiving ? 'player.archived' : 'player.restored',
          actor: { email: admin.email, role: 'admin' },
          team,
          player: { id: target.id, name: target.name },
          details: `${target.name} ${archiving ? 'archived' : 'restored'} on ${team.name}`,
        }).catch(() => {});
        rebuildStandings(circuitCode(team.circuit)).catch(err =>
          console.error('rebuildStandings after archive failed:', err));
        return json({ ok: true, action, player: { id: target.id, name: target.name, archived: !!target.archived }, activeCount: roster.filter(p => !p.archived).length });
      }

      case 'set-captain': {
        const roster = team.roster || [];
        const target = roster.find(p => p.id === body.playerId);
        if (!target) return json({ error: 'Player not found on team' }, 404);
        // Clear existing captain flags
        for (const p of roster) p.isCaptain = false;
        target.isCaptain = true;
        // Sync captain name + email
        team.captain = target.name;
        if (target.email) team.captainEmail = target.email;
        team.roster = roster;
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);
        await logActivity({
          type: 'captain.set',
          actor: { email: admin.email, role: 'admin' },
          team,
          player: { id: target.id, name: target.name },
          details: `${target.name} set as captain of ${team.name}`,
        });
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
        await logActivity({
          type: 'cocaptain.set',
          actor: { email: admin.email, role: 'admin' },
          team,
          player: { id: target.id, name: target.name },
          details: `${target.name} set as co-captain of ${team.name}`,
        });
        return json({ ok: true, coCaptain: target });
      }

      case 'remove-cocaptain': {
        const roster = team.roster || [];
        for (const p of roster) p.isCoCaptain = false;
        team.roster = roster;
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);
        await logActivity({
          type: 'cocaptain.removed',
          actor: { email: admin.email, role: 'admin' },
          team,
          details: `Co-captain removed on ${team.name}`,
        });
        return json({ ok: true });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

/**
 * Pushes a renamed team's new name into every blob that snapshotted it:
 *   1. schedule/<circuit>/<div>/week-N.json  — match.teamA/teamB.name
 *   2. score/<matchId>.json                  — home/away.name
 *   3. lineup/<matchId>/<teamId>.json        — teamName
 *   4. standings + player-stats aggregates   — via rebuildStandings (reads team blobs)
 * Scans the whole circuit prefix (all divisions) so a simultaneous division
 * change can't strand a stale name under the old division.
 */
async function propagateTeamRename(team) {
  const circuit = circuitCode(team.circuit);
  const scheduleStore = getStore('schedule');
  const scoresStore = getStore('scores');
  const lineupStore = getStore('lineups');

  // 1. Schedule blobs — also collect this team's matchIds for steps 2 & 3.
  const myMatchIds = [];
  const { blobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` });
  for (const b of blobs) {
    const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    let dirty = false;
    for (const m of data.matches) {
      const mine = m.teamA?.id === team.id ? m.teamA : m.teamB?.id === team.id ? m.teamB : null;
      if (!mine) continue;
      myMatchIds.push(m.id);
      if (mine.name !== team.name) { mine.name = team.name; dirty = true; }
    }
    if (dirty) await scheduleStore.setJSON(b.key, data);
  }

  // 2. Score records + 3. lineup records for those matches.
  for (const matchId of myMatchIds) {
    const scoreKey = `score/${matchId}.json`;
    const score = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null);
    if (score) {
      let dirty = false;
      if (score.home?.id === team.id && score.home.name !== team.name) { score.home.name = team.name; dirty = true; }
      if (score.away?.id === team.id && score.away.name !== team.name) { score.away.name = team.name; dirty = true; }
      if (dirty) await scoresStore.setJSON(scoreKey, score);
    }

    const lineupKey = `lineup/${matchId}/${team.id}.json`;
    const lineup = await lineupStore.get(lineupKey, { type: 'json' }).catch(() => null);
    if (lineup && lineup.teamName !== team.name) {
      lineup.teamName = team.name;
      await lineupStore.setJSON(lineupKey, lineup);
    }
  }

  // 4. Standings + player-stats aggregates re-read team blobs on rebuild.
  await rebuildStandings(circuit);
}

export const config = { path: '/.netlify/functions/admin-teams' };
