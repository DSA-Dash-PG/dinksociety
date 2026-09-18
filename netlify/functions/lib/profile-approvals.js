// netlify/functions/lib/profile-approvals.js
//
// The one place a pending profile / photo change gets approved or rejected.
// Called by admin-profile-approvals.js (the Profile Approvals tab) and by
// approval-decide.js (the one-tap Approve / Deny links in the admin email), so
// both paths do exactly the same thing to the same records.
//
// Storage model (see lib/profile.js): the roster entry (or the lite player
// record) carries `pendingProfile` = { ...changedFields, photo?, submittedBy,
// submittedAt }. The pending photo binary lives at player-photos/pending/<id>.
//
//   approve → pending fields copied into `profile`, pending photo promoted to
//             img/<id> and `photo` stamped, pendingProfile cleared.
//   reject  → pendingProfile dropped, pending photo binary deleted.

import { getStore } from '@netlify/blobs';
import { PROFILE_FIELDS } from './profile.js';
import { getLiteById, updateLite, isLiteId } from './ladder-players.js';

export const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export class ApprovalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Apply a decision to one player's pending profile change.
 * @param {{ teamId?:string|null, playerId:string, action:'approve'|'reject' }} o
 * @returns {Promise<{ ok:true, action:string, playerId:string, name:string, teamName:string }>}
 * @throws {ApprovalError} 400 bad input · 404 not found · 409 nothing pending
 */
export async function decideProfileChange({ teamId, playerId, action }) {
  teamId = String(teamId || '').trim();
  playerId = String(playerId || '').trim();
  if (!VALID_ID.test(playerId)) throw new ApprovalError('Invalid id', 400);
  const lite = !teamId || isLiteId(playerId);
  if (!lite && !VALID_ID.test(teamId)) throw new ApprovalError('Invalid id', 400);
  if (action !== 'approve' && action !== 'reject') throw new ApprovalError('action must be approve or reject', 400);

  const photoStore = getStore('player-photos');

  // ── Ladder-only player: pending edits live on their own record ──
  if (lite) {
    const rec = await getLiteById(playerId);
    if (!rec) throw new ApprovalError('Player not found', 404);
    const pp = rec.pendingProfile;
    if (!pp) throw new ApprovalError('Nothing pending for this player', 409);
    const next = { pendingProfile: null };

    if (action === 'approve') {
      const nextProfile = { ...(rec.profile || {}) };
      for (const f of PROFILE_FIELDS) {
        if (!(f in pp)) continue;
        const v = pp[f];
        if (v === '' || v == null) delete nextProfile[f];
        else nextProfile[f] = v;
      }
      next.profile = nextProfile;
      if (pp.photo) {
        const blob = await photoStore.getWithMetadata(`pending/${playerId}`, { type: 'arrayBuffer' }).catch(() => null);
        if (blob && blob.data) {
          await photoStore.set(`img/${playerId}`, blob.data, {
            metadata: { contentType: blob.metadata?.contentType || pp.photo.contentType || 'image/jpeg' },
          });
          next.photo = { updatedAt: new Date().toISOString(), contentType: pp.photo.contentType || 'image/jpeg' };
        }
        await photoStore.delete(`pending/${playerId}`).catch(() => {});
      }
    } else if (pp.photo) {
      await photoStore.delete(`pending/${playerId}`).catch(() => {});
    }

    await updateLite(playerId, next);
    return { ok: true, action, playerId, name: rec.name || '', teamName: 'Ladder player' };
  }

  // ── League player: pending edits live on the roster entry ──
  const teamsStore = getStore('teams');
  const teamKey = `team/${teamId}.json`;
  const team = await teamsStore.get(teamKey, { type: 'json', consistency: 'strong' }).catch(() => null);
  if (!team) throw new ApprovalError('Team not found', 404);
  const entry = (team.roster || []).find(p => p.id === playerId);
  if (!entry) throw new ApprovalError('Player not found', 404);
  const pp = entry.pendingProfile;
  if (!pp) throw new ApprovalError('Nothing pending for this player', 409);

  if (action === 'approve') {
    const nextProfile = { ...(entry.profile || {}) };
    for (const f of PROFILE_FIELDS) {
      if (f in pp) {
        const v = pp[f];
        if (v === '' || v == null) delete nextProfile[f];
        else nextProfile[f] = v;
      }
    }
    entry.profile = nextProfile;

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
  } else if (pp.photo) {
    await photoStore.delete(`pending/${playerId}`).catch(() => {});
  }

  delete entry.pendingProfile;
  team.updatedAt = new Date().toISOString();
  await teamsStore.setJSON(teamKey, team);

  return { ok: true, action, playerId, name: entry.name || '', teamName: team.name || '' };
}
