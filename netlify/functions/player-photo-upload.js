// netlify/functions/player-photo-upload.js
// Upload (or replace) a player's profile photo. One photo per player, keyed by
// playerId, stored in the 'player-photos' blob store.
//
// POST multipart/form-data with: file, playerId, teamId
//   Auth: admin (any) → goes LIVE immediately (admins are the approvers).
//         the player themselves OR their captain → goes to PENDING approval.
//
// PENDING binary  → "pending/<playerId>"   (awaiting admin approval)
// APPROVED binary → "img/<playerId>"       (served publicly)
// The roster entry inside the `teams` blob is stamped so pages know state:
//   pendingProfile.photo = { updatedAt, contentType }   (awaiting)
//   photo                = { updatedAt, contentType }    (approved/live)

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, verifyCaptainSession, verifyPlayerSession } from './lib/auth.js';

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB — Lambda payload ceiling (client compresses first)
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const playerId = (formData.get('playerId') || '').toString().trim();
    let teamId = (formData.get('teamId') || '').toString().trim();

    if (!VALID_ID.test(playerId)) {
      return new Response(JSON.stringify({ error: 'Invalid playerId' }), { status: 400, headers });
    }

    // ── Authorize and decide live-vs-pending ──
    const admin = await verifyAdminSession(req);
    let isAdmin = admin.valid;
    let authorized = isAdmin;

    if (!authorized) {
      const player = await verifyPlayerSession(req);
      if (player.valid && player.payload.playerId === playerId) {
        authorized = true;
        teamId = player.payload.teamId || teamId;
      }
    }
    if (!authorized) {
      const cap = await verifyCaptainSession(req);
      if (cap.valid && cap.payload.team) {
        const onTeam = (cap.payload.team.roster || []).some(p => p.id === playerId);
        if (onTeam) { authorized = true; teamId = cap.payload.team.id; }
      }
    }
    if (!authorized) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
    }
    if (!VALID_ID.test(teamId)) {
      return new Response(JSON.stringify({ error: 'Invalid teamId' }), { status: 400, headers });
    }

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400, headers });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return new Response(JSON.stringify({ error: 'Only JPG, PNG, or WebP allowed' }), { status: 400, headers });
    }
    if (file.size > MAX_BYTES) {
      return new Response(JSON.stringify({
        error: `File is ${(file.size / 1024 / 1024).toFixed(1)}MB — exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit. Photos should auto-compress before upload; refresh and try again.`,
      }), { status: 400, headers });
    }

    // Load team + locate the roster entry to stamp.
    const teamsStore = getStore('teams');
    const teamKey = `team/${teamId}.json`;
    const team = await teamsStore.get(teamKey, { type: 'json' }).catch(() => null);
    if (!team) {
      return new Response(JSON.stringify({ error: 'Team not found' }), { status: 404, headers });
    }
    const entry = (team.roster || []).find(p => p.id === playerId);
    if (!entry) {
      return new Response(JSON.stringify({ error: 'Player not on this team' }), { status: 404, headers });
    }

    const photoStore = getStore('player-photos');
    const arrayBuffer = await file.arrayBuffer();
    const updatedAt = new Date().toISOString();
    const stamp = { updatedAt, contentType: file.type };

    if (isAdmin) {
      // Admin upload → live immediately.
      await photoStore.set(`img/${playerId}`, arrayBuffer, { metadata: { contentType: file.type } });
      entry.photo = stamp;
      if (entry.pendingProfile) delete entry.pendingProfile.photo;
    } else {
      // Player/captain upload → pending approval.
      await photoStore.set(`pending/${playerId}`, arrayBuffer, { metadata: { contentType: file.type } });
      entry.pendingProfile = {
        ...(entry.pendingProfile || {}),
        photo: stamp,
        submittedBy: (await whoLabel(req)),
        submittedAt: updatedAt,
      };
    }

    team.updatedAt = updatedAt;
    await teamsStore.setJSON(teamKey, team);

    return new Response(JSON.stringify({ ok: true, playerId, status: isAdmin ? 'live' : 'pending', updatedAt }), { status: 200, headers });
  } catch (err) {
    console.error('player-photo-upload error:', err);
    return new Response(JSON.stringify({ error: 'Upload failed', detail: err.message }), { status: 500, headers });
  }
};

async function whoLabel(req) {
  const p = await verifyPlayerSession(req);
  if (p.valid) return 'player';
  const c = await verifyCaptainSession(req);
  if (c.valid) return 'captain';
  return 'unknown';
}

export const config = { path: '/.netlify/functions/player-photo-upload' };
