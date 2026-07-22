// netlify/functions/lib/organizer-auth.js
// Auth guards for the ORGANIZER role. An organizer signs in through the normal
// player magic-link (ds_player_session); this layer additionally checks that the
// signed-in email is an ACTIVE organizer, and — for ladder actions — that they
// OWN the ladder in question (event.ownerEmail === their email).
//
// Admins always pass ownership checks (the league owner can see/do everything);
// the point of the ownership gate is to wall one organizer off from another's
// ladders. Revocation is instant: requireOrganizer re-reads the organizer store
// on every call, so flipping status to 'suspended' rejects the next request.

import { verifyPlayerSession, verifyAdminSession } from './auth.js';
import { getOrganizer } from './organizers.js';
import { getEvent } from './ladder.js';
import { normalizeEmail } from './identity.js';

function sessionEmail(payload) {
  return normalizeEmail(payload?.session?.email || payload?.player?.email || payload?.email);
}

/**
 * Require an active organizer session.
 * Returns { ok:true, email, name, playerId, organizer }
 *      or { ok:false, status, error }.
 */
export async function requireOrganizer(req) {
  const v = await verifyPlayerSession(req);
  if (!v.valid) return { ok: false, status: 401, error: 'Sign in to continue.' };
  const email = sessionEmail(v.payload);
  if (!email) return { ok: false, status: 401, error: 'No email on session.' };
  const org = await getOrganizer(email);
  if (!org || org.status !== 'active') {
    return { ok: false, status: 403, error: 'Not an active organizer.' };
  }
  return {
    ok: true,
    email,
    name: org.name || v.payload.player?.name || '',
    playerId: v.payload.playerId || org.playerId || null,
    organizer: org,
  };
}

/**
 * Require that the caller may manage a specific ladder: either an admin, or the
 * active organizer who owns it. Pass eventId=null for organizer-scoped actions
 * that aren't tied to one ladder (e.g. "create").
 * Returns { ok:true, role:'admin'|'organizer', email, event, organizer? }
 *      or { ok:false, status, error }.
 */
export async function requireLadderOwner(req, eventId = null) {
  // Admin/owner first — they can manage any ladder.
  const a = await verifyAdminSession(req);
  if (a.valid) {
    const event = eventId ? await getEvent(eventId) : null;
    if (eventId && !event) return { ok: false, status: 404, error: 'Ladder not found.' };
    return { ok: true, role: 'admin', email: a.payload.email, event };
  }
  const org = await requireOrganizer(req);
  if (!org.ok) return org;
  if (!eventId) return { ok: true, role: 'organizer', email: org.email, event: null, organizer: org.organizer };
  const event = await getEvent(eventId);
  if (!event) return { ok: false, status: 404, error: 'Ladder not found.' };
  if (normalizeEmail(event.ownerEmail) !== org.email) {
    return { ok: false, status: 403, error: 'You do not own this ladder.' };
  }
  return { ok: true, role: 'organizer', email: org.email, event, organizer: org.organizer };
}

/** Standard error Response for a failed organizer/ownership check. */
export function orgErr(res) {
  return new Response(JSON.stringify({ error: res.error || 'Unauthorized' }), {
    status: res.status || 401, headers: { 'Content-Type': 'application/json' },
  });
}
