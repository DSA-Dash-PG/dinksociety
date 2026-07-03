// netlify/functions/player-ladder-events.js
// GET /.netlify/functions/player-ladder-events  (authed player session)
// Returns the logged-in player's UPCOMING ladder events, mirroring how the
// portal shows upcoming league matches:
//   { registered: [...], open: [...] }
// - registered: events where the player is on the roster/waitlist (matched by
//   email, the ladder's identity link), so they "see their upcoming ladder games".
// - open: upcoming events with spots left that they could still join.
// Reuses the shared ladder helpers so this stays in sync with the Ladders page.

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { listEvents, getSignups, findEntry, effectiveCapacity, spotsLeft, eventStartMs } from './lib/ladder.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const email = (ctx.session?.email || ctx.player?.email || ctx.player?.normalizedEmail || '').toLowerCase();

  let events = [];
  try { events = await listEvents({}); } catch { events = []; }

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  // Upcoming = not finished/cancelled, and starts today-or-later (keep same-day
  // events visible for a few hours after start as a grace window).
  const upcoming = events.filter((e) => {
    if (e.status === 'final' || e.status === 'cancelled') return false;
    const startMs = eventStartMs(e);
    if (startMs) return startMs >= now - 6 * 3600 * 1000;
    return (e.date || '') >= today;
  });

  const registered = [], open = [];
  for (const e of upcoming) {
    let signups = null;
    try { signups = await getSignups(e.id); } catch { signups = null; }
    const entry = email && signups ? findEntry(signups, email) : null;
    const cap = effectiveCapacity(e);
    const left = signups ? spotsLeft(e, signups) : cap;
    const base = {
      id: e.id, name: e.name || 'Ladder', date: e.date || null,
      startTime: e.startTime || null, place: e.place || null,
      status: e.status || 'open', spotsLeft: left, capacity: cap,
      // Payment info so the portal can offer a one-tap Venmo deep link.
      venmoHandle: e.venmoHandle || null, feeCents: Number(e.feeCents) || 0,
      paymentMethods: Array.isArray(e.paymentMethods) && e.paymentMethods.length ? e.paymentMethods : null,
    };
    if (entry) {
      registered.push({ ...base, list: entry.list, paymentStatus: entry.entry?.paymentStatus || null });
    } else if (e.status === 'open' && left > 0) {
      open.push(base);
    }
  }

  const byDate = (a, b) => String(a.date || '').localeCompare(String(b.date || ''));
  registered.sort(byDate);
  open.sort(byDate);
  return json({ registered, open });
};

export const config = { path: '/.netlify/functions/player-ladder-events' };
