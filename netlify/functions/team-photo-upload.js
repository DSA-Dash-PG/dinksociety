// netlify/functions/team-photo-upload.js
// Upload (or replace) a team's photo. One photo per team, keyed by teamId.
//
// POST multipart/form-data with: file, teamId
//   Auth: an admin (any team) OR the captain/co-captain of that team.
//
// Binary is stored in the 'team-photos' blob store under "img/<teamId>".
// The team blob gets a `photo: { updatedAt, contentType }` stamp so the
// public page knows a photo exists and can cache-bust on change.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, verifyCaptainSession } from './lib/auth.js';

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
    const teamId = (formData.get('teamId') || '').toString().trim();

    if (!VALID_ID.test(teamId)) {
      return new Response(JSON.stringify({ error: 'Invalid teamId' }), { status: 400, headers });
    }

    // ── Authorize: admin (any team) OR captain of THIS team ──
    const admin = await verifyAdminSession(req);
    let authorized = admin.valid;
    if (!authorized) {
      const cap = await verifyCaptainSession(req);
      if (cap.valid && cap.payload.team && cap.payload.team.id === teamId) authorized = true;
    }
    if (!authorized) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
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

    // Make sure the team exists before we store anything.
    const teamsStore = getStore('teams');
    const teamKey = `team/${teamId}.json`;
    const team = await teamsStore.get(teamKey, { type: 'json' }).catch(() => null);
    if (!team) {
      return new Response(JSON.stringify({ error: 'Team not found' }), { status: 404, headers });
    }

    // Store the binary, keyed by teamId (one photo per team — re-upload overwrites).
    const photoStore = getStore('team-photos');
    const arrayBuffer = await file.arrayBuffer();
    await photoStore.set(`img/${teamId}`, arrayBuffer, {
      metadata: { contentType: file.type },
    });

    // Stamp the team blob so the public page knows a photo exists + can cache-bust.
    const updatedAt = new Date().toISOString();
    team.photo = { updatedAt, contentType: file.type };
    team.updatedAt = updatedAt;
    await teamsStore.setJSON(teamKey, team);

    return new Response(JSON.stringify({ ok: true, teamId, updatedAt }), { status: 200, headers });
  } catch (err) {
    console.error('team-photo-upload error:', err);
    return new Response(JSON.stringify({ error: 'Upload failed', detail: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/.netlify/functions/team-photo-upload' };
