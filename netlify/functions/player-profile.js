// netlify/functions/player-profile.js
// Submit edits to a player's bio fields (height, dob, plays, city, homeCourt).
//
// PUT JSON: { playerId, teamId?, profile: { height?, dob?, plays?, city?, homeCourt? } }
//   Auth: admin (any)            → applied to LIVE profile immediately.
//         the player themselves  → written to pendingProfile (awaits approval).
//         their captain          → written to pendingProfile (awaits approval).
//
// Only the five bio fields are touched here — name/gender/email/leadership are
// owned by captain-roster.js and cannot be changed through this endpoint. The
// one exception is a ladder-only ("lite") player's GENDER: they have no captain
// to set it for them, and men's/women's-only ladders need it, so they may set
// their own (applied live — it gates eligibility, it isn't public bio content).
// DOB is stored but never emitted publicly (see lib/profile.js).
//
// NAME: a player (or their captain) may request a display-name change via
// `body.name`. Like bio edits it goes into pendingProfile.name and waits for the
// one-tap Approve / Deny email (Richard, 2026-09-22). An admin edit is live.
// On approval lib/profile-approvals.js sets the roster name and patches every
// player-stats/<circuit>.json row so the leaderboard + Drop links update at once.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, verifyCaptainSession, verifyPlayerSession } from './lib/auth.js';
import { cleanProfileInput, notifyAdminsPendingProfile } from './lib/profile.js';
import { getLiteById, updateLite } from './lib/ladder-players.js';
import { setPlayerInfo } from './lib/player-directory.js';
import { patchStatsName } from './lib/profile-approvals.js';

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function whatLabel(patch) {
  const hasName = 'name' in patch;
  const bio = Object.keys(patch).some(k => k !== 'name');
  return hasName && bio ? 'name change + bio update' : hasName ? 'name change' : 'bio update';
}

// Letters (incl. accented), spaces, apostrophes, periods, hyphens, and a
// parenthetical nickname like "Emanuel (E) Escamilla". 2–60 chars.
function cleanName(raw) {
  if (raw == null) return { name: null };
  const name = String(raw).replace(/\s+/g, ' ').trim();
  if (!name) return { error: 'Name can’t be blank.' };
  if (name.length < 2 || name.length > 60) return { error: 'Name must be 2–60 characters.' };
  if (!/^[\p{L}][\p{L}\p{M} .'’()\-]*$/u.test(name)) return { error: 'Name can only use letters, spaces, and . \' - ( )' };
  return { name };
}


export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };
  if (req.method !== 'PUT' && req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const playerId = (body.playerId || '').toString().trim();
    let teamId = (body.teamId || '').toString().trim();

    if (!VALID_ID.test(playerId)) {
      return new Response(JSON.stringify({ error: 'Invalid playerId' }), { status: 400, headers });
    }

    // ── Authorize + decide live-vs-pending ──
    const admin = await verifyAdminSession(req);
    let isAdmin = admin.valid;
    let authorized = isAdmin;
    let submittedBy = 'admin';

    let isLite = false;
    if (!authorized) {
      const player = await verifyPlayerSession(req);
      if (player.valid && player.payload.playerId === playerId) {
        authorized = true; submittedBy = 'player';
        teamId = player.payload.teamId || teamId;
        isLite = !player.payload.teamId;
      }
    }
    if (!authorized) {
      const cap = await verifyCaptainSession(req);
      if (cap.valid && cap.payload.team) {
        const onTeam = (cap.payload.team.roster || []).some(p => p.id === playerId);
        if (onTeam) { authorized = true; submittedBy = 'captain'; teamId = cap.payload.team.id; }
      }
    }
    if (!authorized) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
    }
    if (isAdmin && !teamId && await getLiteById(playerId)) isLite = true;
    if (!isLite && !VALID_ID.test(teamId)) {
      return new Response(JSON.stringify({ error: 'Invalid teamId' }), { status: 400, headers });
    }

    // ── Validate the patch ──
    const { profile: patch, error } = cleanProfileInput(body.profile);
    if (error) return new Response(JSON.stringify({ error }), { status: 400, headers });
    const gender = ['M', 'F'].includes(body.gender) ? body.gender : null;
    const { name: newName, error: nameErr } = cleanName(body.name);
    if (nameErr) return new Response(JSON.stringify({ error: nameErr }), { status: 400, headers });
    if (Object.keys(patch).length === 0 && !(isLite && gender) && !newName) {
      return new Response(JSON.stringify({ error: 'No profile fields supplied' }), { status: 400, headers });
    }

    // ── Ladder-only player: their own record holds bio, pending edits, gender ──
    if (isLite) {
      const rec = await getLiteById(playerId);
      if (!rec) return new Response(JSON.stringify({ error: 'Player not found' }), { status: 404, headers });
      const now = new Date().toISOString();
      const next = {};
      // Name: admin → live; player → pending approval.
      const wantsName = !!(newName && newName !== rec.name);
      let nameChanged = false;
      if (wantsName && isAdmin) {
        next.name = newName; nameChanged = true;
        try { await setPlayerInfo(playerId, { name: newName }); }
        catch (e) { console.warn('[player-profile] directory name save failed:', e?.message || e); }
      } else if (wantsName) {
        patch.name = newName;
      }
      if (isAdmin) {
        if (Object.keys(patch).length) next.profile = { ...(rec.profile || {}), ...patch };
      } else if (Object.keys(patch).length) {
        next.pendingProfile = { ...(rec.pendingProfile || {}), ...patch, submittedBy, submittedAt: now };
      }
      // Gender goes live either way — nobody else can set it for them.
      if (gender) {
        next.gender = gender;
        try { await setPlayerInfo(playerId, { gender }); }
        catch (e) { console.warn('[player-profile] directory gender save failed:', e?.message || e); }
      }
      await updateLite(playerId, next);
      if (!isAdmin && Object.keys(patch).length) {
        await notifyAdminsPendingProfile({
          playerName: rec.name, teamName: 'Ladder player', submittedBy, what: whatLabel(patch),
          teamId: null, playerId, entry: { ...rec, ...next },
        });
      }
      return new Response(JSON.stringify({
        ok: true, playerId, status: isAdmin || !Object.keys(patch).length ? 'live' : 'pending',
        name: next.name || rec.name, nameChanged, namePending: !isAdmin && wantsName,
      }), { status: 200, headers });
    }

    // ── Load team + roster entry ──
    const teamsStore = getStore('teams');
    const teamKey = `team/${teamId}.json`;
    const team = await teamsStore.get(teamKey, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!team) return new Response(JSON.stringify({ error: 'Team not found' }), { status: 404, headers });
    const entry = (team.roster || []).find(p => p.id === playerId);
    if (!entry) return new Response(JSON.stringify({ error: 'Player not on this team' }), { status: 404, headers });

    const now = new Date().toISOString();
    // Name: admin → live; player/captain → pending approval with the bio edits.
    const wantsName = !!(newName && newName !== entry.name);
    const nameChanged = wantsName && isAdmin;
    if (nameChanged) {
      entry.previousNames = [...(entry.previousNames || []), { name: entry.name, changedAt: now, by: 'admin' }].slice(-5);
      entry.name = newName;
    } else if (wantsName) {
      patch.name = newName;
    }
    const hasBio = Object.keys(patch).length > 0;

    if (!hasBio) {
      // name-only save — nothing to queue
    } else if (isAdmin) {
      // Admin edit → live.
      entry.profile = { ...(entry.profile || {}), ...patch };
    } else {
      // Player/captain edit → pending (merge with any pending photo).
      entry.pendingProfile = {
        ...(entry.pendingProfile || {}),
        ...patch,
        submittedBy,
        submittedAt: now,
      };
    }

    team.updatedAt = now;
    await teamsStore.setJSON(teamKey, team);
    if (nameChanged) await patchStatsName(playerId, newName);

    // Notify admins when something now needs approval.
    if (!isAdmin && hasBio) {
      await notifyAdminsPendingProfile({
        playerName: entry.name, teamName: team.name, submittedBy, what: whatLabel(patch),
        teamId, playerId, entry,
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      playerId,
      status: (isAdmin || !hasBio) ? 'live' : 'pending',
      name: entry.name, nameChanged, namePending: !isAdmin && wantsName,
    }), { status: 200, headers });
  } catch (err) {
    console.error('player-profile error:', err);
    return new Response(JSON.stringify({ error: 'Save failed', detail: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/.netlify/functions/player-profile' };
