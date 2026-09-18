// netlify/functions/captain-roster.js
// GET:  returns captain's team + full roster
// PUT:  replaces the team's roster
//
// Roster entry shape:
//   { id, name, gender: 'M' | 'F', email?, phone?, dupr?, linkedUserId? }
//
// gender is REQUIRED because it's used for slot enforcement in lineups.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail, normalizePhone, findContactCollisions } from './lib/identity.js';
import { circuitCode } from './lib/circuit.js';
import { buildLeagueIndex, playedBefore, playedForTeam } from './lib/league-players.js';
import { sendRosterWelcomesSafe } from './lib/roster-welcome.js';
import { notifyAdminsPendingRosterAdd } from './lib/roster-approvals.js';

// No roster size cap — rosters are unlimited; every add still goes through admin approval.

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  const store = getStore('teams');
  const teamKey = `team/${ctx.team.id}.json`;

  if (req.method === 'GET') {
    const rosterLocked = await isRosterLocked(ctx.team);
    return json({ team: ctx.team, rosterLocked });
  }

  if (req.method === 'PUT') {
    try {
      // Roster locks once the team's Week 2 match is complete, unless an admin
      // has set the per-team unlock flag. Server-enforced so it can't be bypassed.
      if (await isRosterLocked(ctx.team)) {
        return json({ error: 'Your roster is locked for the season (Week 2 has been played). Ask a league admin to unlock it if you need a change.' }, 423);
      }

      const body = await req.json();
      const roster = Array.isArray(body.roster) ? body.roster : [];

      // Validate each entry. Only NAME is strictly required so the captain can
      // build the roster incrementally — gender and email are completed over
      // time and surfaced as "incomplete" in roster health, NOT enforced here.
      // (Hard-requiring email/gender on EVERY row meant one incomplete player
      // blocked saving everyone — so an edit to a complete player was discarded
      // and the captain got stuck in a loop. Format is still validated when a
      // value IS provided; gender is enforced at lineup time, email at sign-in.)
      const cleaned = [];
      const ids = new Set();
      // Only entries that actually carry an id — otherwise a stored row with no
      // id puts an `undefined` key in the map, and every NEW player (whose id is
      // also undefined at this point) matches it and silently inherits that
      // row's state instead of being treated as an addition.
      const existingById = new Map((ctx.team.roster || []).filter(x => x && x.id).map(x => [x.id, x]));

      // ── Who needs league approval ──────────────────────────────────────
      // Getting one of YOUR OWN players back is not a decision the league needs
      // to make — a team re-registering gets a brand-new team blob, so without
      // this every one of last season's squad queues up as a stranger.
      // Someone from another team still goes to the queue: that's a transfer in
      // all but name, and the league wants eyes on it.
      //
      // "Your own" spans seasons via sameTeamLineage() — same team id, the
      // recorded prior team, same captain, or same team name.
      //
      // Loaded lazily: an ordinary save that only edits existing players never
      // touches the blob store for this.
      const hasNewcomers = roster.some(p => p && typeof p === 'object' && !existingById.has(p.id));
      const leagueByEmail = hasNewcomers
        ? (await buildLeagueIndex().catch(() => ({ byEmail: new Map() }))).byEmail
        : new Map();
      const autoAddedNow = [];
      // Ids queued for league approval ON THIS SAVE — the admins get one
      // "approve / deny" email per person, right now, instead of finding out
      // when they next open the console.
      const requestedNow = [];

      for (const p of roster) {
        if (!p || typeof p !== 'object') continue;
        const name = (p.name || '').toString().trim();
        if (!name) return json({ error: 'Every player needs a name' }, 400);

        // Gender: optional here, but if set it must be M/F.
        let gender = (p.gender || '').toString().toUpperCase();
        if (gender && !['M', 'F'].includes(gender)) gender = '';

        // Email: optional here, but if set it must be a valid address.
        const email = sanitize(p.email, 120);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json({ error: `${name}'s email doesn't look valid. Fix it or clear it, then save.` }, 400);
        }

        const id = p.id || generateId();
        if (ids.has(id)) return json({ error: 'Duplicate player id' }, 400);
        ids.add(id);

        let phone = sanitize(p.phone, 30);
        let dupr = sanitize(p.dupr, 10);
        // Leadership flags are preserved from the stored roster — the client
        // can't grant or strip captain/co-captain through this endpoint.
        // (Previously a roster save silently wiped these flags.)
        const prev = existingById.get(p.id) || null;
        // A captain can edit and remove their own players freely. Adding
        // someone splits two ways:
        //
        //   known to the league  → straight onto the roster. Their email is
        //                          already on a roster somewhere, so there is
        //                          nothing left for an admin to vet.
        //   never seen before    → a REQUEST. Approval is what makes them a
        //                          roster member; until then they're visible
        //                          only to their own captain.
        //
        // An existing player keeps whatever state they already had, so an
        // ordinary save can neither approve a pending add nor un-approve
        // someone already on the team.
        const isNew = !prev;
        let pendingState = {};
        if (isNew) {
          const known = email ? playedBefore(leagueByEmail, email) : null;
          const withYou = known ? playedForTeam(known, ctx.team) : null;
          // Whatever the league already holds fills the blanks either way — it
          // costs nothing and an approval still gets a complete record to read.
          if (known) {
            if (!gender && known.gender) gender = known.gender;
            if (!phone && known.phone) phone = known.phone;
            if (!dupr && known.dupr) dupr = known.dupr;
          }
          if (withYou) {
            pendingState = {
              returningPlayer: true,
              addedAt: new Date().toISOString(),
              addedFrom: { teamName: withYou.teamName, seasonName: withYou.seasonName },
            };
            autoAddedNow.push({
              id, name: name.slice(0, 60),
              teamName: withYou.teamName || '', seasonName: withYou.seasonName || '',
            });
          } else {
            const from = known ? (known.stints[0] || null) : null;
            requestedNow.push(id);
            pendingState = {
              pendingAdd: true,
              pendingAddAt: new Date().toISOString(),
              pendingAddBy: ctx.user?.email || ctx.session?.email || ctx.captainEmail || 'captain',
              // Played in the league, just not for this team — the admin queue
              // shows where from, so the reviewer isn't guessing.
              ...(from ? { pendingAddFrom: { teamName: from.teamName, seasonName: from.seasonName } } : {}),
            };
          }
        } else if (prev.pendingAdd) {
          pendingState = {
            pendingAdd: true,
            pendingAddAt: prev.pendingAddAt || null,
            pendingAddBy: prev.pendingAddBy || null,
            ...(prev.pendingAddFrom ? { pendingAddFrom: prev.pendingAddFrom } : {}),
          };
        } else if (prev.returningPlayer) {
          pendingState = {
            returningPlayer: true,
            addedAt: prev.addedAt || null,
            addedFrom: prev.addedFrom || null,
          };
        }
        cleaned.push({
          id,
          name: name.slice(0, 60),
          gender,
          email,
          phone,
          // Normalized contact keys — recomputed on every save so they never
          // drift from the raw values. Used by the duplicate sweep.
          normalizedEmail: email ? normalizeEmail(email) : null,
          normalizedPhone: phone ? normalizePhone(phone) : null,
          dupr,
          linkedUserId: p.linkedUserId || (prev ? prev.linkedUserId : null) || null,
          // Profile bio fields + photo + pending-approval state are owned by the
          // player-profile / player-photo / approval endpoints. Preserve them
          // from the stored roster so an ordinary roster save can't wipe them.
          ...(prev?.profile ? { profile: prev.profile } : {}),
          ...(prev?.pendingProfile ? { pendingProfile: prev.pendingProfile } : {}),
          ...(prev?.photo ? { photo: prev.photo } : {}),
          ...(prev?.isCaptain ? { isCaptain: true } : {}),
          ...(prev?.isCoCaptain ? { isCoCaptain: true } : {}),
          // Sub flag is owned by the set-sub endpoint — preserve it so a plain
          // roster save can't wipe it.
          ...(prev?.isSub ? { isSub: true } : {}),
          // Archive state is owned by the archive/restore endpoint — preserve it
          // from the stored roster so an ordinary roster save can't flip or wipe it.
          ...(prev?.archived ? { archived: true, archivedAt: prev.archivedAt || null, archivedBy: prev.archivedBy || null } : {}),
          ...pendingState,
        });
      }

      // Flag (don't block) likely-duplicate people on this roster — two entries
      // sharing a normalized email or phone. Shared household contact info is a
      // legitimate (if rare) case, so we surface it for the captain to confirm
      // rather than rejecting the save.
      const duplicateWarnings = findContactCollisions(cleaned);

      const updated = {
        ...ctx.team,
        ...(typeof body.emoji === 'string' ? { emoji: body.emoji.trim().slice(0, 8) } : {}),
        roster: cleaned,
        rosterUpdatedAt: new Date().toISOString(),
      };
      await store.setJSON(teamKey, updated);

      // Welcome the players who actually JOINED on this save. Anyone queued for
      // approval is deliberately left out — admin-roster-approvals welcomes
      // them if and when the league says yes. Awaited so the send completes
      // before the lambda returns, but it can never fail the save.
      if (autoAddedNow.length) {
        await sendRosterWelcomesSafe({
          teamId: ctx.team.id,
          playerIds: autoAddedNow.map(p => p.id),
          addedByName: ctx.user?.name || ctx.team?.captainName || '',
        });
      }

      // Tell the league about each new approval request — with the player's
      // details and one-tap Approve / Deny links. Best-effort, never fails the save.
      for (const pid of requestedNow) {
        const player = cleaned.find(p => p.id === pid);
        if (player) await notifyAdminsPendingRosterAdd({ team: updated, player });
      }

      return json({
        team: updated,
        duplicateWarnings,
        pendingApproval: cleaned.filter(p => p.pendingAdd).map(p => ({ id: p.id, name: p.name })),
        // Added on this save without a queue because the league already knows
        // them — the UI says so rather than a bare "Saved", so the captain
        // understands why one player waits and another doesn't.
        autoAdded: autoAddedNow,
      });
    } catch (err) {
      console.error('captain-roster PUT error:', err);
      return json({ error: 'Save failed', detail: err.message }, 500);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

/**
 * Roster locks once the team's Week 2 match has been finalized.
 * Admin can reopen it per-team by setting team.rosterUnlocked = true.
 */
async function isRosterLocked(team) {
  if (!team) return false;
  if (team.rosterUnlocked === true) return false; // admin override
  try {
    const scheduleStore = getStore('schedule');
    const key = `schedule/${circuitCode(team.circuit)}/${team.division}/week-2.json`;
    const data = await scheduleStore.get(key, { type: 'json' }).catch(() => null);
    if (!data?.matches) return false;
    const m = data.matches.find(x => x.teamA?.id === team.id || x.teamB?.id === team.id);
    return !!(m && m.finalizedAt);
  } catch {
    return false; // never block a save because the lock check itself errored
  }
}

function sanitize(val, maxLen) {
  if (!val) return null;
  return String(val).trim().slice(0, maxLen) || null;
}

function generateId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'p_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-roster' };
