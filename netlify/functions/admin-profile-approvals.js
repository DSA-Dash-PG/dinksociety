// netlify/functions/admin-profile-approvals.js
// Admin-only review queue for pending player profile + photo changes.
//
// GET  → { pending: [ { teamId, teamName, playerId, name, current, proposed,
//                       photoPending, photoPreviewUrl, submittedBy, submittedAt } ] }
// Ladder-only ("lite") players have no team, so their pending edits live on
// their own record and are queued here alongside everyone else's — with teamId
// null, which is also how the POST recognizes them.
//
// POST { teamId, playerId, action: 'approve' | 'reject' }
//   approve → copies pendingProfile fields into the live profile, promotes the
//             pending photo (pending/<id> → img/<id>) and stamps photo, clears pendingProfile.
//   reject  → discards pendingProfile and deletes any pending photo binary.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { PROFILE_FIELDS } from './lib/profile.js';
import { listLitePlayers } from './lib/ladder-players.js';
import { decideProfileChange, ApprovalError } from './lib/profile-approvals.js';

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
        // Strong consistency: a pending edit may have been written seconds ago;
        // an eventual read can miss it and the queue would look empty.
        const raw = await teamsStore.get(blob.key, { consistency: 'strong' });
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
      // Ladder-only players — same shape, no team behind them.
      for (const rec of await listLitePlayers().catch(() => [])) {
        const pp = rec.pendingProfile;
        if (!pp) continue;
        const hasFieldChange = PROFILE_FIELDS.some(f => f in pp);
        const photoPending = !!pp.photo;
        if (!hasFieldChange && !photoPending) continue;
        const current = {}; const proposed = {};
        for (const f of PROFILE_FIELDS) {
          current[f] = (rec.profile || {})[f] ?? null;
          if (f in pp) proposed[f] = pp[f] ?? '';
        }
        pending.push({
          teamId: null,
          teamName: 'Ladder player',
          playerId: rec.playerId,
          name: rec.name,
          current,
          proposed,
          photoPending,
          photoPreviewUrl: photoPending
            ? `/.netlify/functions/player-photo-serve?id=${encodeURIComponent(rec.playerId)}&pending=1&v=${encodeURIComponent(pp.photo.updatedAt || '')}`
            : null,
          submittedBy: pp.submittedBy || 'unknown',
          submittedAt: pp.submittedAt || null,
        });
      }

      pending.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
      return new Response(JSON.stringify({ pending }), { status: 200, headers });
    } catch (err) {
      console.error('admin-profile-approvals GET error:', err);
      return new Response(JSON.stringify({ error: 'Failed to load queue' }), { status: 500, headers });
    }
  }

  // ── POST: approve / reject ──
  // The decision itself lives in lib/profile-approvals.js so the one-tap email
  // links (approval-decide.js) and this tab can never drift apart.
  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}));
      const out = await decideProfileChange({
        teamId: (body.teamId || '').toString().trim(),
        playerId: (body.playerId || '').toString().trim(),
        action: (body.action || '').toString(),
      });
      return new Response(JSON.stringify({ ok: true, action: out.action, playerId: out.playerId }), { status: 200, headers });
    } catch (err) {
      if (err instanceof ApprovalError) {
        return new Response(JSON.stringify({ error: err.message }), { status: err.status, headers });
      }
      console.error('admin-profile-approvals POST error:', err);
      return new Response(JSON.stringify({ error: 'Action failed', detail: err.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
};

export const config = { path: '/.netlify/functions/admin-profile-approvals' };
