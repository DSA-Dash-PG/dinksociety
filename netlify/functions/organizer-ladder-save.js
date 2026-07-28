// netlify/functions/organizer-ladder-save.js
// POST /api/organizer-ladder-save — an ORGANIZER creates/updates one of their
// own ladder nights. Mirrors admin-ladder-save, but scoped and locked down:
//   • ownerEmail is forced to the signed-in organizer (never trust the body)
//   • payment is VENMO / CASH only (paymentMethods:['venmo']); no Stripe
//   • new ladders default leaderboard:'pending' — admin must approve before they
//     aggregate into the running leaderboard (the ladder's own board is always public)
//   • no league-wide "new ladder" email blast (that megaphone is admin-only)
// Everything else — recaps, reminders, signup/waitlist/Venmo emails — works exactly
// as it does for an admin ladder, because an organizer ladder is a normal event.
//
// Pass `id` to update; omit to create.

import crypto from 'crypto';
import { requireOrganizer } from './lib/organizer-auth.js';
import { getEvent, setEvent, capacityFromCourts } from './lib/ladder.js';
import { normalizeEmail } from './lib/identity.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const org = await requireOrganizer(req);
  if (!org.ok) return json({ error: org.error }, org.status);

  const b = await req.json().catch(() => ({}));
  if (!b.name || !b.date) return json({ error: 'name and date are required' }, 400);

  // On update, the ladder must exist AND belong to this organizer.
  let existing = null;
  if (b.id) {
    existing = await getEvent(b.id);
    if (!existing) return json({ error: 'Ladder not found.' }, 404);
    if (normalizeEmail(existing.ownerEmail) !== org.email) {
      return json({ error: 'You do not own this ladder.' }, 403);
    }
  }
  const id = b.id || crypto.randomBytes(6).toString('hex');

  const courts = Math.max(0, Math.floor(Number(b.courts) || 0));
  const feeCents = b.feeCents != null ? Math.round(Number(b.feeCents)) : Math.round((Number(b.fee) || 0) * 100);
  const capacity = b.capacity != null && +b.capacity > 0 ? Math.floor(+b.capacity) : capacityFromCourts(courts);
  const courtNames = Array.isArray(b.courtNames)
    ? b.courtNames.map(s => String(s).trim()).filter(Boolean).slice(0, 20)
    : (existing?.courtNames || []);
  const rounds = Number.isFinite(+b.rounds) && +b.rounds > 0 ? Math.min(20, Math.floor(+b.rounds)) : (existing?.rounds ?? 10);
  const roundMin = Number.isFinite(+b.roundMin) && +b.roundMin > 0 ? Math.min(60, Math.floor(+b.roundMin)) : (existing?.roundMin ?? 12);
  const scoreMode = ['points', 'winby2', 'to11', 'to15'].includes(b.scoreMode) ? b.scoreMode : (existing?.scoreMode || 'points');

  const event = {
    id,
    circuit: existing?.circuit || 'I',
    name: String(b.name).slice(0, 120),
    date: b.date,
    startTime: b.startTime || existing?.startTime || '',
    endTime: b.endTime || existing?.endTime || '',
    place: b.place || existing?.place || '',
    courts,
    courtNames,
    rounds,
    roundMin,
    scoreMode,
    courtNumbers: courtNames.length ? courtNames.join(' · ') : (existing?.courtNumbers || null),
    capacity,
    feeCents: Number.isFinite(feeCents) ? feeCents : 0,
    // Organizer ladders are Venmo/cash only — no Stripe. "Cash" is simply a Venmo-
    // method signup the organizer marks paid by hand from their roster.
    paymentMethods: ['venmo'],
    venmoHandle: b.venmoHandle || existing?.venmoHandle || null,
    waitlist: b.waitlist !== false,
    spotOpenPolicy: b.spotOpenPolicy === 'auto' ? 'auto' : 'hold',
    // Organizers collect their own money, so the league credit system doesn't apply.
    cancelPolicy: ['auto_credit', 'credit_if_refilled', 'no_credit'].includes(b.cancelPolicy) ? b.cancelPolicy : 'no_credit',
    type: ['mixed', 'mens', 'womens'].includes(b.type) ? b.type : (existing?.type || 'mixed'),
    fcfsWindowHours: Number.isFinite(+b.fcfsWindowHours) ? +b.fcfsWindowHours : (existing?.fcfsWindowHours ?? 24),
    // Venmo-claim confirmations and drop notices go to the organizer.
    organizers: [org.email],
    ownerEmail: org.email,
    // Held out of the running leaderboard until an admin approves. Preserved on update.
    leaderboard: existing?.leaderboard || 'pending',
    status: b.status || existing?.status || 'open',
    createdAt: existing?.createdAt || new Date().toISOString(),
    createdBy: existing?.createdBy || org.email,
    announcedAt: existing?.announcedAt || null,
  };

  await setEvent(event);
  return json({ ok: true, created: !b.id, event });
};

export const config = { path: '/.netlify/functions/organizer-ladder-save' };
