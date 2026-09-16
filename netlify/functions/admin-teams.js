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
import { circuitCode, seasonName, seasonIdForCircuit, isCanonicalCode } from './lib/circuit.js';
import { rebuildStandings } from './lib/standings.js';
import { logActivity } from './lib/activity-log.js';
import { sendRosterWelcomesSafe } from './lib/roster-welcome.js';

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

// ── Division sync ─────────────────────────────────────────────
// The team blob is what the public pages read, but admin-seed-teams ("Sync
// Teams") treats the confirmed REGISTRATION as the source of truth for
// division and rewrites the team from it. So a division change made in the
// Team editor has to land on the registration too, or the next Sync flips
// the team straight back.
/**
 * The registration a team record came from.
 *
 * Tries the recorded link first (the confirm flow stores registrationId, the
 * seed flow stores seededFromRegistrationId), then falls back to captain email
 * + season — never email alone, which would reach across seasons.
 */
async function findLinkedRegistration(team) {
  const regStore = getStore('registrations');
  const wantEmail = (team.captainEmail || '').toLowerCase().trim();
  const wantSeason = circuitCode(team.circuit || team.seasonId);

  const linkedId = team.registrationId || team.seededFromRegistrationId || null;
  if (linkedId) {
    for (const key of [`confirmed/${linkedId}.json`, `pending/${linkedId}.json`, linkedId]) {
      const reg = await regStore.get(key, { type: 'json' }).catch(() => null);
      if (reg) return { store: regStore, key, reg };
    }
  }

  if (wantEmail) {
    const { blobs } = await regStore.list({ prefix: 'confirmed/' });
    for (const b of blobs) {
      const reg = await regStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!reg || reg.path !== 'team') continue;
      const email = (reg.team?.players?.[0]?.email || '').toLowerCase().trim();
      if (email !== wantEmail) continue;
      if (wantSeason && circuitCode(reg.circuit || reg.seasonId) !== wantSeason) continue;
      return { store: regStore, key: b.key, reg };
    }
  }
  return null;
}

async function syncRegistrationDivision(team, oldDivision) {
  const hit = await findLinkedRegistration(team);
  if (!hit) return { synced: false, reason: 'no linked registration' };
  const { store, key, reg } = hit;
  reg.division = team.division;
  reg.divisionLabel = team.divisionLabel || reg.divisionLabel || null;
  reg.updatedAt = new Date().toISOString();
  reg.divisionMoved = { from: oldDivision || null, to: team.division, at: reg.updatedAt };
  await store.set(key, JSON.stringify(reg));
  return { synced: true, registrationId: reg.id };
}

/**
 * Push a team rename onto its registration.
 *
 * The registration holds the name typed at sign-up and nothing ever updated it,
 * so a renamed team disagreed with its registration forever — and "Sync from
 * Registrations" used to stamp the old name straight back over the rename.
 * Renaming the team is the admin saying what the team is called, so the
 * registration follows it, exactly as it already does for a division move.
 */
async function syncRegistrationName(team, oldName) {
  const hit = await findLinkedRegistration(team);
  if (!hit) return { synced: false, reason: 'no linked registration' };
  const { store, key, reg } = hit;
  if (!reg.team || typeof reg.team !== 'object') return { synced: false, reason: 'registration has no team block' };
  reg.team.name = team.name;
  reg.updatedAt = new Date().toISOString();
  reg.renamed = { from: oldName || null, to: team.name, at: reg.updatedAt };
  await store.set(key, JSON.stringify(reg));
  return { synced: true, registrationId: reg.id };
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
    // Team records carry whatever was written into `circuit` at the time — the
    // code ('I'), the season NAME ('Season 1'), or an old broken derivation
    // ('SEASON-2'). Resolving that on the client meant every caller reinvented
    // circuitCode() and got it subtly wrong, which is how the admin Teams tab
    // ended up listing two "Season 1"s. Stamp the canonical code here so there
    // is exactly one implementation and the UI never has to guess.
    const withCode = (t) => t && { ...t, circuitCode: circuitCode(t.circuit || t.seasonId) };

    if (teamId) {
      const team = await store.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
      if (!team) return json({ error: 'Team not found' }, 404);
      return json({ team: withCode(team) });
    }

    const { blobs } = await store.list({ prefix: 'team/' });
    const teams = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(Boolean);

    teams.sort((a, b) => (a.division || '').localeCompare(b.division || '') || (a.name || '').localeCompare(b.name || ''));
    return json({ teams: teams.map(withCode) });
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
    const oldDivision = team.division;
    const allowed = ['name', 'emoji', 'color', 'secondaryColor', 'notes', 'division', 'divisionLabel', 'bio'];

    for (const field of allowed) {
      if (field in body) {
        team[field] = body[field];
      }
    }

    // Self-heal the season key on any save. Old records hold a display name or a
    // mangled id here; leaving them means every new reader has to cope with it.
    const canonical = circuitCode(team.circuit || team.seasonId);
    if (team.circuit !== canonical) team.circuit = canonical;

    // Ids present before this save — anything else in the result is someone
    // the admin has just introduced, and they get welcomed like any other add.
    // Declared out here because the welcome step below runs OUTSIDE the roster
    // block; when it lived inside, that step threw a ReferenceError after the
    // blob was already written, so every roster add/edit saved but returned a
    // 500 and the admin UI never closed the popup or refreshed.
    const priorIds = new Set((team.roster || []).map(x => x && x.id).filter(Boolean));

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
          // Sub = backup player, excluded from automatic availability reminders.
          // A sub can't simultaneously be captain/co-captain.
          isSub: !!p.isSub && !p.isCaptain && !p.isCoCaptain,
          // Profile bio / pending edits / photo stamp are owned by the profile
          // endpoints — preserve (or live-merge) them so a team save can't wipe them.
          ...(mergedProfile ? { profile: mergedProfile } : {}),
          ...(prev?.pendingProfile ? { pendingProfile: prev.pendingProfile } : {}),
          ...(prev?.photo ? { photo: prev.photo } : {}),
          ...(prev?.archived ? { archived: true, archivedAt: prev.archivedAt || null, archivedBy: prev.archivedBy || null } : {}),
          // Pending captain adds are owned by the approvals endpoint — a plain
          // roster save must not silently approve them by dropping the flag.
          ...(prev?.pendingAdd ? { pendingAdd: prev.pendingAdd, pendingAddAt: prev.pendingAddAt || null, pendingAddBy: prev.pendingAddBy || null } : {}),
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

    // Division moved → push it onto the registration too (see syncRegistrationDivision)
    // and refresh standings so the team shows under its new division immediately.
    let divisionSync = null;
    const divisionChanged = 'division' in body && team.division !== oldDivision;
    if (divisionChanged) {
      divisionSync = await syncRegistrationDivision(team, oldDivision).catch(err => {
        console.error('Registration division sync failed:', err);
        return { synced: false, reason: err.message };
      });
      await logActivity({
        type: 'team.division_moved',
        actor: { email: admin.email, role: 'admin' },
        team,
        details: `Division ${oldDivision || '—'} → ${team.division}` + (divisionSync?.synced ? '' : ' (registration not updated: ' + (divisionSync?.reason || 'unknown') + ')'),
      });
      rebuildStandings(circuitCode(team.circuit)).catch(err =>
        console.error('rebuildStandings after division move failed:', err));
    }

    await logActivity({
      type: body.roster ? 'roster.replaced' : 'team.updated',
      actor: { email: admin.email, role: 'admin' },
      team,
      details: ('name' in body && team.name !== oldName)
        ? `Team renamed "${oldName}" → "${team.name}"`
        : body.roster
          ? `Roster replaced (${(team.roster || []).length} players)`
          : `Team settings updated (${Object.keys(body).filter(k => allowed.includes(k)).join(', ') || 'fields'})`,
    }}).catch(err => console.error('logActivity after team save failed:', err));

    // The team blob is the source of truth for the name, but the name is also
    // SNAPSHOTTED into schedule matches, score records, and lineup records when
    // those are created. On rename, push the new name into every copy so the
    // whole site updates — otherwise public schedule/standings keep the old name.
    if ('name' in body && team.name !== oldName) {
      // The registration keeps the name typed at sign-up. Push the new one onto
      // it so the two never drift, and so a later Sync has nothing to disagree
      // about. Best-effort: a rename must not fail because of this.
      const nameSync = await syncRegistrationName(team, oldName)
        .catch(err => ({ synced: false, reason: err.message }));
      if (!nameSync.synced) {
        console.warn(`Team renamed but registration not updated (${nameSync.reason})`);
      }
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
      const introduced = (team.roster || [])
        .filter(p => p && p.id && p.email && !priorIds.has(p.id))
        .map(p => p.id);
      if (introduced.length) {
        await sendRosterWelcomesSafe({ teamId, playerIds: introduced });
      }
    }
    if (divisionChanged && divisionSync && !divisionSync.synced) {
      return json({ ok: true, team, warning: 'Division saved on the team, but no linked registration was found to update (' + divisionSync.reason + '). "Sync Teams" may revert it — fix the registration division too.' });
    }
    return json({ ok: true, team });
  }

  // ========== POST — actions ==========
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');
    const body = await req.json();

    switch (action) {
      // ── Delete a team record ───────────────────────────────────────────
      // There was no way to remove a team at all, which matters because
      // "Sync from Registrations" could mint a duplicate from a registration
      // that already had a team (it matched on captain email alone). Deleting
      // the duplicate was only half a fix — the next Sync re-created it. Both
      // halves now exist: this, and registration-id matching in seed-teams.
      //
      // Refuses while the team still has match records, unless `force` is set:
      // deleting a team that played leaves orphaned names in the schedule and
      // scores, which is almost never what someone means.
      case 'delete-team': {
        const code = circuitCode(team.circuit || team.seasonId);
        let matchCount = 0;
        try {
          const schedStore = getStore('schedule');
          const { blobs } = await schedStore.list({ prefix: `schedule/${code}/` });
          for (const b of blobs) {
            const wk = await schedStore.get(b.key, { type: 'json' }).catch(() => null);
            for (const m of (wk?.matches || [])) {
              if (m.teamA?.id === team.id || m.teamB?.id === team.id) matchCount++;
            }
          }
        } catch { /* advisory only */ }

        if (matchCount > 0 && body.force !== true) {
          return json({
            error: `${team.name} still has ${matchCount} match record(s) in ${seasonName(code)}. `
                 + 'Deleting it would leave those matches pointing at a team that no longer exists.',
            matchCount, needsForce: true,
          }, 409);
        }

        await store.delete(teamKey);

        await logActivity({
          type: 'team.deleted',
          actor: { email: admin.email, role: 'admin' },
          team,
          details: `Team deleted from ${seasonName(code)}`
            + (matchCount ? ` (forced \u2014 ${matchCount} match record(s) left behind)` : '')
            + ` \u00b7 ${(team.roster || []).length} roster entr${(team.roster || []).length === 1 ? 'y' : 'ies'}`,
        }).catch(() => {});

        // Drop it out of the public standings straight away.
        await rebuildStandings(code).catch(err =>
          console.error('rebuildStandings after team delete failed:', err?.message || err));

        return json({ ok: true, deleted: teamId, teamName: team.name, matchCount });
      }

      // ── Move a team to a different season ──────────────────────────────
      // A team record is per-season and its season lives in two fields that
      // drifted apart on older records (`circuit` holding 'Season 1', 'II' or
      // nothing; `seasonId` often null). Nothing could edit them, so a team
      // filed under the wrong season was stuck there — showing up in the wrong
      // season's Teams tab and standings with no way to correct it.
      //
      // Both fields are written together here, and the aggregates for BOTH the
      // old and the new season are rebuilt: leaving the old one stale is what
      // makes a moved team appear in two seasons at once.
      //
      // Existing schedule/score records are NOT moved — they stay keyed to the
      // circuit they were played in, which is what you want for a finished
      // season. The response says how many matches were left behind so the
      // admin isn't guessing.
      case 'move-season': {
        const target = circuitCode(body.circuit || body.seasonId);
        if (!isCanonicalCode(target)) {
          return json({ error: `"${body.circuit || body.seasonId}" is not a season I recognize.` }, 400);
        }
        const fromCode = circuitCode(team.circuit || team.seasonId);
        if (fromCode === target && !('division' in body)) {
          return json({ error: `${team.name} is already in ${seasonName(target)}.` }, 409);
        }

        // Matches already played under the old season — reported, not moved.
        let strandedMatches = 0;
        try {
          const schedStore = getStore('schedule');
          const { blobs } = await schedStore.list({ prefix: `schedule/${fromCode}/` });
          for (const b of blobs) {
            const wk = await schedStore.get(b.key, { type: 'json' }).catch(() => null);
            for (const m of (wk?.matches || [])) {
              if (m.teamA?.id === team.id || m.teamB?.id === team.id) strandedMatches++;
            }
          }
        } catch { /* non-fatal — the count is advisory */ }

        team.circuit = target;
        team.seasonId = seasonIdForCircuit(target);
        if (typeof body.division === 'string' && body.division.trim()) {
          team.division = body.division.trim();
          if (typeof body.divisionLabel === 'string') team.divisionLabel = body.divisionLabel.trim();
        }
        team.updatedAt = now;
        team.updatedBy = admin.email;
        await store.setJSON(teamKey, team);

        await logActivity({
          type: 'team.season_moved',
          actor: { email: admin.email, role: 'admin' },
          team,
          details: `Season ${seasonName(fromCode)} → ${seasonName(target)}`
            + (body.division ? ` · division → ${team.division}` : '')
            + (strandedMatches ? ` · ${strandedMatches} existing match record(s) left in ${seasonName(fromCode)}` : ''),
        }).catch(() => {});

        // Awaited: a lambda that returns first kills the rebuild in flight, and
        // a half-rebuilt standings blob is worse than a stale one.
        for (const code of new Set([fromCode, target])) {
          await rebuildStandings(code).catch(err =>
            console.error(`rebuildStandings(${code}) after season move failed:`, err?.message || err));
        }

        return json({
          ok: true, team,
          movedFrom: seasonName(fromCode),
          movedTo: seasonName(target),
          strandedMatches,
        });
      }

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
        // An admin add puts them on the roster just as surely as a captain's
        // does, so it earns the same welcome. No `addedByName`: the admin isn't
        // their captain, and the copy reads fine without a name.
        if (newPlayer.email) {
          await sendRosterWelcomesSafe({ teamId, playerIds: [newPlayer.id] });
        }
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
        target.isSub = false; // captain can't be a sub
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
        target.isSub = false; // co-captain can't be a sub
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
