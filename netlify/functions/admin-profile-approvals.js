// netlify/functions/admin-profile-approvals.js
// Admin-only review queue for pending player profile + photo changes.
//
// GET  → { pending: [ { teamId, teamName, playerId, name, current, proposed,
//                       photoPending, photoPreviewUrl, submittedBy, submittedAt } ] }
// POST { teamId, playerId, action: 'approve' | 'reject' }
//   approve → copies pendingProfile fields into the live profile, promotes the
//             pending photo (pending/<id> → img/<id>) and stamps photo, clears pendingProfile.
//   reject  → discards pendingProfile and deletes any pending photo binary.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { PROFILE_FIELDS } from './lib/profile.js';

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };

  const admin = await verifyAdminSession(req);
  if (!admin.valid) return unauthResponse(admin.error);

  const teamsStore = getStore('teams');

  // ── GET: build the pending queue ──
  if (req.method === 'GET') {
    try {
      const { blobs } = await teamsStore.list();
      const pending = [];
      for (const blob of blobs) {
        const raw = await teamsStore.get(blob.key);
        if (!raw) continue;
        let team;
        try { team = JSON.parse(raw); } catch { continue; }
        for (const p of (team.roster || [])) {
          const pp = p.pendingProfile;
          if (!pp) continue;
          const hasFieldChange = PROFILE_FIELDS.some(f => f in pp);
          const photoPending = !!pp.photo;
          if (!hasFieldChange && !photoPending) continue;

          const current = {};
          const proposed = {};
          for (const f of PROFILE_FIELDS) {
            const cur = (p.profile || {})[f] ?? null;
            current[f] = cur;
            if (f in pp) proposed[f] = pp[f] ?? '';
          }

          pending.push({
            teamId: team.id,
            teamName: team.name,
            playerId: p.id,
            name: p.name,
            current,
            proposed,
            photoPending,
            photoPreviewUrl: photoPending
              ? `/.netlify/functions/player-photo-serve?id=${encodeURIComponent(p.id)}&pending=1&v=${encodeURIComponent(pp.photo.updatedAt || '')}`
              : null,
            submittedBy: pp.submittedBy || 'unknown',
            submittedAt: pp.submittedAt || null,
          });
        }
      }
      pending.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
      return new Response(JSON.stringify({ pending }), { status: 200, headers });
    } catch (err) {
      console.error('admin-profile-approvals GET error:', err);
      return new Response(JSON.stringify({ error: 'Failed to load queue' }), { status: 500, headers });
    }
  }

  // ── POST: approve / reject ──
  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}));
      const teamId = (body.teamId || '').toString().trim();
      const playerId = (body.playerId || '').toString().trim();
      const action = (body.action || '').toString();

      if (!VALID_ID.test(teamId) || !VALID_ID.test(playerId)) {
        return new Response(JSON.stringify({ error: 'Invalid id' }), { status: 400, headers });
      }
      if (action !== 'approve' && action !== 'reject') {
        return new Response(JSON.stringify({ error: 'action must be approve or reject' }), { status: 400, headers });
      }

      const teamKey = `team/${teamId}.json`;
      const team = await teamsStore.get(teamKey, { type: 'json' }).catch(() => null);
      if (!team) return new Response(JSON.stringify({ error: 'Team not found' }), { status: 404, headers });
      const entry = (team.roster || []).find(p => p.id === playerId);
      if (!entry) return new Response(JSON.stringify({ error: 'Player not found' }), { status: 404, headers });
      const pp = entry.pendingProfile;
      if (!pp) return new Response(JSON.stringify({ error: 'Nothing pending for this player' }), { status: 409, headers });

      const photoStore = getStore('player-photos');

      if (action === 'approve') {
        // Apply field changes.
        const nextProfile = { ...(entry.profile || {}) };
        for (const f of PROFILE_FIELDS) {
          if (f in pp) {
            const v = pp[f];
            if (v === '' || v == null) delete nextProfile[f];
            else nextProfile[f] = v;
          }
        }
        entry.profile = nextProfile;

        // Promote pending photo → live.
        if (pp.photo) {
          const blob = await photoStore.getWithMetadata(`pending/${playerId}`, { type: 'arrayBuffer' }).catch(() => null);
          if (blob && blob.data) {
            await photoStore.set(`img/${playerId}`, blob.data, {
              metadata: { contentType: blob.metadata?.contentType || pp.photo.contentType || 'image/jpeg' },
            });
            entry.photo = { updatedAt: new Date().toISOString(), contentType: pp.photo.contentType || 'image/jpeg' };
          }
          await photoStore.delete(`pending/${playerId}`).catch(() => {});
        }
      } else {
        // Reject → drop pending photo binary if any.
        if (pp.photo) await photoStore.delete(`pending/${playerId}`).catch(() => {});
      }

      delete entry.pendingProfile;
      team.updatedAt = new Date().toISOString();
      await teamsStore.setJSON(teamKey, team);

      return new Response(JSON.stringify({ ok: true, action, playerId }), { status: 200, headers });
    } catch (err) {
      console.error('admin-profile-approvals POST error:', err);
      return new Response(JSON.stringify({ error: 'Action failed', detail: err.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
};

export const config = { path: '/.netlify/functions/admin-profile-approvals' };
