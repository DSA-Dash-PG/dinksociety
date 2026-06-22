// netlify/functions/admin-ladder-manage.js
// Admin management of one ladder's signups. Admin session required.
//
//   GET    ?event=<id>                          → full signups (incl. emails/payment)
//   POST   ?event=<id>  { action, ... }         → mutate
//       action 'remove'        { playerId|email }  remove from roster → credit + promote
//       action 'confirm-venmo' { playerId|email }  mark a Venmo signup paid
//       action 'decline-venmo' { playerId|email }  release it → promote next
//       action 'promote'                           promote head of waitlist now
//       action 'set-status'    { status }          open|full|live|final|cancelled
//   DELETE ?event=<id>                          → delete the ladder + its signups

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail } from './lib/identity.js';
import {
  getEvent, setEvent, getSignups, setSignups, removeFromRoster,
  effectiveCapacity, spotsLeft,
} from './lib/ladder.js';
import { promoteAndNotify } from './lib/ladder-promote.js';
import { earn } from './lib/credits.js';
import { dateLineOf } from './lib/ladder-notify.js';
import { sendEmail, renderLadderConfirmed } from './lib/email.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}
const findRosterEntry = (s, playerId, email) => {
  const norm = normalizeEmail(email);
  return s.roster.find(p => (playerId && p.playerId === playerId) || (norm && normalizeEmail(p.email) === norm));
};

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);
  const event = await getEvent(eventId);
  if (!event) return json({ error: 'Ladder not found' }, 404);

  // ── admin view (full detail) ──
  if (req.method === 'GET') {
    const s = await getSignups(eventId);
    return json({
      event,
      capacity: effectiveCapacity(event),
      spotsLeft: spotsLeft(event, s),
      roster: s.roster, waitlist: s.waitlist, pendingClaim: s.pendingClaim,
    });
  }

  // ── delete the ladder ──
  if (req.method === 'DELETE') {
    await getStore({ name: 'ladder-events', consistency: 'strong' }).delete(`event/${eventId}.json`).catch(() => {});
    await getStore({ name: 'ladder-signups', consistency: 'strong' }).delete(`signup/${eventId}.json`).catch(() => {});
    return json({ ok: true, deleted: eventId });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.json().catch(() => ({}));
  const action = body.action;
  const signups = await getSignups(eventId);
  const feeCents = Number(event.feeCents) || 0;

  if (action === 'set-status') {
    const status = ['open', 'full', 'live', 'final', 'cancelled'].includes(body.status) ? body.status : null;
    if (!status) return json({ error: 'invalid status' }, 400);
    event.status = status;
    await setEvent(event);
    return json({ ok: true, status });
  }

  if (action === 'promote') {
    const r = await promoteAndNotify(event, signups);
    await setSignups(signups);
    return json({ ok: true, opened: r.opened });
  }

  // Admin manually adds a player (e.g. paid cash, no email). `paid` marks them
  // paid-by-cash; `force` adds to the roster even if it's at capacity.
  if (action === 'add') {
    const name = String(body.name || '').trim();
    if (!name) return json({ error: 'name required' }, 400);
    const gender = body.gender === 'F' ? 'F' : body.gender === 'M' ? 'M' : null;
    const email = String(body.email || '').trim().toLowerCase();
    const paid = !!body.paid;
    // Use an existing master-roster id when provided (links their stats/profile);
    // otherwise mint a fresh manual id.
    const pid = body.playerId ? String(body.playerId) : ('manual_' + Math.random().toString(36).slice(2, 10));
    if (body.playerId && (signups.roster || []).some(p => p.playerId === pid)) return json({ error: 'Already on the roster' }, 409);
    if (spotsLeft(event, signups) > 0 || body.force) {
      signups.roster.push({
        playerId: pid, name, email, gender,
        signedUpAt: new Date().toISOString(),
        paymentMethod: paid ? 'cash' : null,
        paymentStatus: paid ? 'paid' : 'pending',
        amountCents: paid ? feeCents : null,
        checkoutSessionId: null, invitedBy: null, heldUntil: null, addedByAdmin: true,
      });
      await setSignups(signups);
      return json({ ok: true, added: name, list: 'roster', paid });
    }
    signups.waitlist.push({ playerId: pid, name, email, gender, joinedAt: new Date().toISOString(), addedByAdmin: true });
    await setSignups(signups);
    return json({ ok: true, added: name, list: 'waitlist' });
  }

  if (action === 'confirm-venmo') {
    const entry = findRosterEntry(signups, body.playerId, body.email);
    if (!entry) return json({ error: 'Player not on the roster' }, 404);
    entry.paymentStatus = 'paid';
    entry.paymentMethod = 'venmo';
    entry.heldUntil = null;
    await setSignups(signups);
    if (entry.email) {
      await sendEmail({ to: entry.email, subject: `You're in — ${event.name}`, html: renderLadderConfirmed({ playerName: entry.name, eventName: event.name, dateLine: dateLineOf(event) }) }).catch(() => {});
    }
    return json({ ok: true, paid: entry.name });
  }

  // Admin manually marks a roster player paid (cash/venmo received in person) or
  // reverses it. Works for any roster entry, including manually-added pending ones.
  if (action === 'mark-paid' || action === 'mark-unpaid') {
    const entry = findRosterEntry(signups, body.playerId, body.email);
    if (!entry) return json({ error: 'Player not on the roster' }, 404);
    if (action === 'mark-paid') {
      entry.paymentStatus = 'paid';
      entry.paymentMethod = body.method || (entry.paymentMethod && entry.paymentMethod !== 'card' ? entry.paymentMethod : 'cash');
      entry.amountCents = entry.amountCents != null ? entry.amountCents : feeCents;
      entry.heldUntil = null;
    } else {
      entry.paymentStatus = 'pending';
      entry.heldUntil = null;
    }
    await setSignups(signups);
    return json({ ok: true, paid: action === 'mark-paid', name: entry.name });
  }

  if (action === 'remove' || action === 'decline-venmo') {
    const removed = removeFromRoster(signups, { playerId: body.playerId, email: body.email });
    if (!removed) {
      // maybe on the waitlist
      const i = signups.waitlist.findIndex(p => (body.playerId && p.playerId === body.playerId) || (normalizeEmail(body.email) && normalizeEmail(p.email) === normalizeEmail(body.email)));
      if (i >= 0) { signups.waitlist.splice(i, 1); await setSignups(signups); return json({ ok: true, removedFrom: 'waitlist' }); }
      return json({ error: 'Player not found on this ladder' }, 404);
    }
    // credit on admin removal only for a genuine cancel of a PAID spot under auto_credit
    let credited = 0;
    if (action === 'remove' && event.cancelPolicy === 'auto_credit' && removed.paymentStatus === 'paid' && feeCents > 0 && removed.email) {
      await earn(removed.email, feeCents, `Removed from ${event.name}`, { eventId, key: `adminremove:${eventId}:${normalizeEmail(removed.email)}` }).catch(() => {});
      credited = feeCents;
    }
    const r = await promoteAndNotify(event, signups);
    await setSignups(signups);
    return json({ ok: true, removed: removed.name, creditedCents: credited, opened: r.opened });
  }

  return json({ error: 'unknown action' }, 400);
};

export const config = { path: '/.netlify/functions/admin-ladder-manage' };
