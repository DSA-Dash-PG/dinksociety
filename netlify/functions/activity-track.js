// netlify/functions/activity-track.js
// Lightweight usage beacon from the player, captain, and admin portals.
// POST { tab?, event? } with a valid session.
//   event: 'visit' → recordVisit (page load; session-gap visit counter + event)
//   else           → recordSeen  (tab switch; bumps lastSeenAt + tab counter)
// Fire-and-forget on the client (sendBeacon); always answers 204.

import { verifyPlayerSession, verifyCaptainSession, verifyAdminSession } from './lib/auth.js';
import { recordSeen, recordVisit } from './lib/activity-log.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 204 });

  let body = {};
  try { body = await req.json(); } catch { /* sendBeacon may post text */ }
  const tab = typeof body.tab === 'string' ? body.tab : null;
  const isVisit = body.event === 'visit';

  // Player session first (me.html), then captain (captain.html), then admin.
  const asPlayer = await verifyPlayerSession(req);
  if (asPlayer.valid) {
    const ctx = asPlayer.payload;
    const args = { email: ctx.session.email, tab, name: ctx.player?.name || null, team: ctx.team };
    await (isVisit ? recordVisit({ ...args, role: 'player' }) : recordSeen(args));
    return new Response(null, { status: 204 });
  }

  const asCaptain = await verifyCaptainSession(req);
  if (asCaptain.valid) {
    const ctx = asCaptain.payload;
    const args = { email: ctx.user.email, tab, team: ctx.team };
    await (isVisit ? recordVisit({ ...args, role: ctx.user?.role || 'captain' }) : recordSeen(args));
    return new Response(null, { status: 204 });
  }

  const asAdmin = await verifyAdminSession(req);
  if (asAdmin.valid) {
    const args = { email: asAdmin.payload?.email, tab };
    await (isVisit ? recordVisit({ ...args, role: 'admin' }) : recordSeen(args));
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 }); // never error a beacon
};

export const config = { path: '/.netlify/functions/activity-track' };
