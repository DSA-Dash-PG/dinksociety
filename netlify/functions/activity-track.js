// netlify/functions/activity-track.js
// Lightweight usage beacon from the player portal (me.html) and captain
// portal. POST { tab? } with a player OR captain session — bumps the
// person's lastSeenAt + per-tab counters in the activity-log store.
// Fire-and-forget on the client (sendBeacon); always answers 204.

import { verifyPlayerSession, verifyCaptainSession } from './lib/auth.js';
import { recordSeen } from './lib/activity-log.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 204 });

  let body = {};
  try { body = await req.json(); } catch { /* sendBeacon may post text */ }
  const tab = typeof body.tab === 'string' ? body.tab : null;

  // Player session first (me.html), captain session as fallback (captain.html).
  const asPlayer = await verifyPlayerSession(req);
  if (asPlayer.valid) {
    const ctx = asPlayer.payload;
    await recordSeen({ email: ctx.session.email, tab, name: ctx.player?.name || null, team: ctx.team });
    return new Response(null, { status: 204 });
  }
  const asCaptain = await verifyCaptainSession(req);
  if (asCaptain.valid) {
    const ctx = asCaptain.payload;
    await recordSeen({ email: ctx.user.email, tab, team: ctx.team });
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 204 }); // never error a beacon
};

export const config = { path: '/.netlify/functions/activity-track' };
