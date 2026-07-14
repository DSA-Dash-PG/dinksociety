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
import { authScoreAccess } from './lib/ladder-scorer.js';
import { normalizeEmail } from './lib/identity.js';
import {
  getEvent, setEvent, getSignups, setSignups, removeFromRoster,
  effectiveCapacity, spotsLeft,
} from './lib/ladder.js';
import { promoteAndNotify } from './lib/ladder-promote.js';
import { findPlayerByEmail } from './lib/player-auth.js';
import { createLitePlayer } from './lib/ladder-players.js';
import { getDirectory, applyDirectoryToSignups } from './lib/player-directory.js';
import { earn } from './lib/credits.js';
import { dateLineOf, cancelLinkFor } from './lib/ladder-notify.js';
import { getPlay } from './lib/ladder-play.js';
import { sendEmail, renderLadderConfirmed, renderLadderRemoved, renderLadderCancelLink } from './lib/email.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}
const findRosterEntry = (s, playerId, email) => {
  const norm = normalizeEmail(email);
  return s.roster.find(p => (playerId && p.playerId === playerId) || (norm && normalizeEmail(p.email) === norm));
};

export default async (req) => {
  const eventId = new URL(req.url).searchParams.get('event');
  const auth = await authScoreAccess(req, eventId);
  if (!auth.ok) return unauthResponse('Unauthorized');
  // Scorer links can only ADD/REMOVE players (subs) on their own night — not read
  // payments/emails (GET), delete the ladder, or run other admin actions.
  if (auth.scorer && req.method !== 'POST') return unauthResponse('Scorer access is limited to scoring.');
  if (!eventId) return json({ error: 'event id required' }, 400);
  const event = await getEvent(eventId);
  if (!event) return json({ error: 'Ladder not found' }, 404);

  // ── admin view (full detail) ──
  if (req.method === 'GET') {
    const s = applyDirectoryToSignups(await getSignups(eventId), await getDirectory());
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
    // Also remove the scored night so it doesn't linger in winners/standings.
    await getStore({ name: 'ladder-play', consistency: 'strong' }).delete(`play/${eventId}.json`).catch(() => {});
    return json({ ok: true, deleted: eventId });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.json().catch(() => ({}));
  const action = body.action;
  if (auth.scorer && action !== 'add' && action !== 'remove') return unauthResponse('Scorer access is limited to roster subs.');
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
    // Admin override: when a specific waitlist row is named (by index), move that
    // person straight onto the roster now — bypassing capacity AND the held-claim
    // flow (which is why the old "promote head into an open spot" did nothing on a
    // full roster). Clears a matching held claim. Falls back to head-promote.
    if (Number.isInteger(body.index) && signups.waitlist && signups.waitlist[body.index]) {
      const w = signups.waitlist.splice(body.index, 1)[0];
      if (signups.pendingClaim && (signups.pendingClaim.email || '').toLowerCase() === (w.email || '').toLowerCase()) {
        signups.pendingClaim = null;
      }
      signups.roster = signups.roster || [];
      signups.roster.push({
        playerId: w.playerId || null, name: w.name, email: (w.email || '').toLowerCase(),
        gender: w.gender || null, signedUpAt: new Date().toISOString(),
        paymentMethod: null, paymentStatus: 'pending', amountCents: null,
        checkoutSessionId: null, invitedBy: w.invitedBy || null, heldUntil: null,
      });
      await setSignups(signups);
      return json({ ok: true, promoted: w.name });
    }
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
    // Resolve a STABLE identity so a returning player isn't minted as a brand-new
    // person on the leaderboard. Priority:
    //   1. explicit master-roster id (picked from search) — links stats/profile
    //   2. existing player matched BY EMAIL (team roster first, then lite account)
    //   3. a fresh email-keyed lite account (so the same email links next time)
    //   4. a manual id (only when there's no usable email)
    let pid;
    if (body.playerId) {
      pid = String(body.playerId);
    } else if (email) {
      try {
        const found = await findPlayerByEmail(email);
        if (found && found.playerId) pid = found.playerId;
        else { const { record } = await createLitePlayer({ name, email, gender }); pid = record.playerId; }
      } catch { pid = null; }
    }
    if (!pid) pid = 'manual_' + Math.random().toString(36).slice(2, 10);
    // Don't add the same resolved person twice (manual ids are always unique).
    if (!String(pid).startsWith('manual_') && (signups.roster || []).some(p => p.playerId === pid)) return json({ error: 'Already on the roster' }, 409);
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
    let emailed = false;
    if (entry.email) {
      await sendEmail({ to: entry.email, subject: `You're in — ${event.name}`, html: renderLadderConfirmed({ playerName: entry.name, eventName: event.name, dateLine: dateLineOf(event), cancelUrl: await cancelLinkFor(event, { playerId: entry.playerId, email: entry.email }) }) }).catch(() => {});
      emailed = true;
    }
    return json({ ok: true, paid: entry.name, name: entry.name, emailed });
  }

  // Admin manually marks a roster player paid (cash/venmo received in person) or
  // reverses it. Works for any roster entry, including manually-added pending ones.
  const PAY_METHODS = ['cash', 'venmo', 'zelle', 'card', 'other'];
  if (action === 'mark-paid' || action === 'mark-unpaid') {
    const entry = findRosterEntry(signups, body.playerId, body.email);
    if (!entry) return json({ error: 'Player not on the roster' }, 404);
    if (action === 'mark-paid') {
      entry.paymentStatus = 'paid';
      entry.paymentMethod = PAY_METHODS.includes(body.method) ? body.method : (entry.paymentMethod && entry.paymentMethod !== 'card' ? entry.paymentMethod : 'cash');
      entry.amountCents = entry.amountCents != null ? entry.amountCents : feeCents;
      entry.heldUntil = null;
    } else {
      entry.paymentStatus = 'pending';
      entry.heldUntil = null;
    }
    await setSignups(signups);
    // Marking paid sends the player the same "you're in" confirmation as Confirm.
    if (action === 'mark-paid' && entry.email) {
      await sendEmail({ to: entry.email, subject: `You're in — ${event.name}`, html: renderLadderConfirmed({ playerName: entry.name, eventName: event.name, dateLine: dateLineOf(event), cancelUrl: await cancelLinkFor(event, { playerId: entry.playerId, email: entry.email }) }) }).catch(() => {});
    }
    return json({ ok: true, paid: action === 'mark-paid', method: entry.paymentMethod, name: entry.name, emailed: action === 'mark-paid' && !!entry.email });
  }

  // Change the recorded payment method on an already-paid player.
  if (action === 'set-method') {
    const entry = findRosterEntry(signups, body.playerId, body.email);
    if (!entry) return json({ error: 'Player not on the roster' }, 404);
    if (!PAY_METHODS.includes(body.method)) return json({ error: 'invalid method' }, 400);
    entry.paymentMethod = body.method;
    if (entry.paymentStatus !== 'paid') { entry.paymentStatus = 'paid'; entry.amountCents = entry.amountCents != null ? entry.amountCents : feeCents; entry.heldUntil = null; }
    await setSignups(signups);
    return json({ ok: true, method: body.method, name: entry.name });
  }

  if (action === 'remove' || action === 'decline-venmo') {
    // Explicit waitlist removal by row index (handles name-only entries with no
    // email/playerId to match on). No credit — they never paid.
    if (action === 'remove' && body.fromWaitlist && Number.isInteger(body.index) && signups.waitlist && signups.waitlist[body.index]) {
      const w = signups.waitlist.splice(body.index, 1)[0];
      await setSignups(signups);
      return json({ ok: true, removed: w.name, removedFrom: 'waitlist' });
    }
    const removed = removeFromRoster(signups, { playerId: body.playerId, email: body.email });
    if (!removed) {
      // maybe on the waitlist
      const i = signups.waitlist.findIndex(p => (body.playerId && p.playerId === body.playerId) || (normalizeEmail(body.email) && normalizeEmail(p.email) === normalizeEmail(body.email)));
      if (i >= 0) { signups.waitlist.splice(i, 1); await setSignups(signups); return json({ ok: true, removedFrom: 'waitlist' }); }
      return json({ error: 'Player not found on this ladder' }, 404);
    }
    // No refunds — a paid spot becomes ladder credit for a future night. Default
    // to auto_credit so removing someone by hand behaves like the self-serve
    // cancel button (which already defaults this way); 'no_credit' events opt out.
    const policy = event.cancelPolicy || 'auto_credit';
    let credited = 0;
    if (action === 'remove' && policy === 'auto_credit' && removed.paymentStatus === 'paid' && feeCents > 0 && removed.email) {
      await earn(removed.email, feeCents, `Removed from ${event.name}`, { eventId, key: `adminremove:${eventId}:${normalizeEmail(removed.email)}` }).catch(() => {});
      credited = feeCents;
    }
    // Tell the removed player what happened — manual removals used to send nothing.
    // Mandatory confirmation (not gated by notify prefs), same as the cancel path.
    let emailedRemoved = false;
    if (action === 'remove' && removed.email) {
      const creditLabel = credited ? `$${(credited / 100).toFixed(2)}` : null;
      await sendEmail({
        to: removed.email,
        subject: `You're off the list — ${event.name}`,
        html: renderLadderRemoved({ playerName: removed.name, eventName: event.name, dateLine: dateLineOf(event), creditLabel }),
      }).catch(() => {});
      emailedRemoved = true;
    }
    const r = await promoteAndNotify(event, signups);
    await setSignups(signups);
    // If rounds are already generated, the removed player is still seated in
    // them — surface a heads-up so the organizer rebuilds the current round.
    let hint = null;
    try {
      const play = await getPlay(eventId);
      if (play?.started && !play.finished) {
        hint = `Night is live — ${removed.name} may still be seated in the current round. Use “Restart round” in the scorer to rebuild it from the updated roster.`;
      }
    } catch { /* best-effort */ }
    // Tell the UI how the spot landed so it can offer the league announcement
    // ("a spot opened up") when nobody on the waitlist took it.
    const openSpots = spotsLeft(event, signups);
    return json({ ok: true, removed: removed.name, creditedCents: credited, emailed: emailedRemoved, opened: r.opened, hint, openSpots, waitlistCount: (signups.waitlist || []).length });
  }

  // Add or edit a roster player's email (e.g. a manually-added player who had
  // none) so they can receive the paid confirmation. Pass value:'' to clear it.
  if (action === 'set-email') {
    const entry = findRosterEntry(signups, body.playerId, body.email);
    if (!entry) return json({ error: 'Player not on the roster' }, 404);
    const newEmail = String(body.value || '').trim().toLowerCase();
    if (newEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) {
      return json({ error: 'That doesn’t look like a valid email.' }, 400);
    }
    entry.email = newEmail;
    await setSignups(signups);
    return json({ ok: true, name: entry.name, email: newEmail });
  }

  // Resend (or send) the "You're in" confirmation to a roster player on demand.
  if (action === 'send-confirmation') {
    const entry = findRosterEntry(signups, body.playerId, body.email);
    if (!entry) return json({ error: 'Player not on the roster' }, 404);
    if (!entry.email) return json({ error: 'No email on file for this player — add one first.' }, 400);
    await sendEmail({
      to: entry.email,
      subject: `You're in — ${event.name}`,
      html: renderLadderConfirmed({ playerName: entry.name, eventName: event.name, dateLine: dateLineOf(event), cancelUrl: await cancelLinkFor(event, { playerId: entry.playerId, email: entry.email }) }),
    }).catch(() => {});
    return json({ ok: true, name: entry.name, email: entry.email, emailed: true });
  }

  // Email a roster player a fresh one-tap cancel link (valid until the ladder
  // starts). Use when a player says they can't make it but their original link
  // expired or they never had one. Sending it does NOT remove them — nothing
  // happens until they tap the link and confirm.
  if (action === 'send-cancel-link') {
    const entry = findRosterEntry(signups, body.playerId, body.email);
    if (!entry) return json({ error: 'Player not on the roster' }, 404);
    if (!entry.email) return json({ error: 'No email on file for this player — add one first.' }, 400);
    const cancelUrl = await cancelLinkFor(event, { playerId: entry.playerId, email: entry.email });
    await sendEmail({
      to: entry.email,
      subject: `Can't make it? Cancel your spot — ${event.name}`,
      html: renderLadderCancelLink({ playerName: entry.name, eventName: event.name, dateLine: dateLineOf(event), cancelUrl }),
    }).catch(() => {});
    return json({ ok: true, name: entry.name, email: entry.email, emailed: true });
  }

  return json({ error: 'unknown action' }, 400);
};

export const config = { path: '/.netlify/functions/admin-ladder-manage' };
