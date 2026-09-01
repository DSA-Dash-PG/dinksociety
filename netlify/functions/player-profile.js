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

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, verifyCaptainSession, verifyPlayerSession } from './lib/auth.js';
import { cleanProfileInput, notifyAdminsPendingProfile } from './lib/profile.js';
import { getLiteById, updateLite } from './lib/ladder-players.js';
import { setPlayerInfo } from './lib/player-directory.js';

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

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
    if (Object.keys(patch).length === 0 && !(isLite && gender)) {
      return new Response(JSON.stringify({ error: 'No profile fields supplied' }), { status: 400, headers });
    }

    // ── Ladder-only player: their own record holds bio, pending edits, gender ──
    if (isLite) {
      const rec = await getLiteById(playerId);
      if (!rec) return new Response(JSON.stringify({ error: 'Player not found' }), { status: 404, headers });
      const now = new Date().toISOString();
      const next = {};
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
          playerName: rec.name, teamName: 'Ladder player', submittedBy, what: 'bio update',
        });
      }
      return new Response(JSON.stringify({
        ok: true, playerId, status: isAdmin || !Object.keys(patch).length ? 'live' : 'pending',
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

    if (isAdmin) {
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

    // Notify admins when something now needs approval.
    if (!isAdmin) {
      await notifyAdminsPendingProfile({
        playerName: entry.name, teamName: team.name, submittedBy, what: 'bio update',
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      playerId,
      status: isAdmin ? 'live' : 'pending',
    }), { status: 200, headers });
  } catch (err) {
    console.error('player-profile error:', err);
    return new Response(JSON.stringify({ error: 'Save failed', detail: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/.netlify/functions/player-profile' };
