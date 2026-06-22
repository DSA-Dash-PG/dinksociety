// netlify/functions/ladder-signup.js
// Player self-serve signup + waitlist + cancel for a ladder.
//
//   GET    ?event=<id>                      → public roster + spots (no auth)
//   POST   ?event=<id>  { paymentMethod, invitedBy? }   → sign up / join waitlist
//   DELETE ?event=<id>                      → cancel my spot (→ ladder credit)
//
// paymentMethod: 'credit' (spend ladder credit), 'venmo' (held; organizer
// confirms via one-tap email), or 'card' (Stripe Checkout — see ladder-checkout).
// Signing up reserves the spot; an outstanding spot beyond capacity goes to the
// waitlist instead.

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail } from './lib/identity.js';
import {
  getEvent, getSignups, setSignups, toPublicSignups,
  addSignup, removeFromRoster, promoteHead, moveWaitlistToRoster,
  findEntry, spotsLeft, cardTotalCents, HOLD_MS,
} from './lib/ladder.js';
import { earn, spend } from './lib/credits.js';
import { createLadderToken } from './lib/ladder-token.js';
import {
  claimUrl, venmoConfirmUrl, venmoDeclineUrl, dateLineOf, organizerEmails, fmtCents, siteUrl,
} from './lib/ladder-notify.js';
import {
  sendEmail, renderVenmoClaimToAdmin, renderLadderSpotOpened, renderLadderConfirmed, renderLadderFcfsOpen,
} from './lib/email.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const eventId = url.searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);

  const event = await getEvent(eventId);
  if (!event) return json({ error: 'Ladder not found' }, 404);

  // ── public read ──
  if (req.method === 'GET') {
    const signups = await getSignups(eventId);
    return json({ event: publicEvent(event), signups: toPublicSignups(event, signups) });
  }

  // everything else needs a signed-in player
  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const { playerId, player, session } = verified.payload;
  const email = (session?.email || player?.email || '').toLowerCase();
  const person = { playerId, name: player?.name || 'Player', email, gender: player?.gender || null };

  const signups = await getSignups(eventId);

  // ── cancel ──
  if (req.method === 'DELETE') {
    const removed = removeFromRoster(signups, { playerId, email });
    if (!removed) {
      // maybe they're only on the waitlist — drop them there
      const i = signups.waitlist.findIndex(p => p.playerId === playerId || normalizeEmail(p.email) === normalizeEmail(email));
      if (i >= 0) { signups.waitlist.splice(i, 1); await setSignups(signups); return json({ ok: true, was: 'waitlist' }); }
      return json({ error: 'You are not signed up for this ladder.' }, 409);
    }

    // credit policy: 'auto_credit' issues credit on any cancel; 'credit_if_refilled'
    // defers until a backfiller pays (handled at confirm time — TODO); 'no_credit' none.
    let credited = 0;
    const policy = event.cancelPolicy || 'auto_credit';
    if (policy === 'auto_credit' && removed.paymentStatus === 'paid') {
      const cents = Number(event.feeCents) || 0;
      if (cents > 0) {
        await earn(email, cents, `Cancelled ${event.name}`, { eventId, key: `cancel:${eventId}:${normalizeEmail(email)}` }).catch(() => {});
        credited = cents;
      }
    }

    // open spot → promote next in line. Inside 24h it's first-come-first-serve:
    // leave the spot open and blast the whole waitlist instead of holding it.
    const next = promoteHead(signups, event);
    await setSignups(signups);
    let opened = null;
    if (next && next.fcfs) { await notifyFcfs(event, signups); opened = 'fcfs'; }
    else if (next) { await notifyPromoted(event, next); opened = next.name; }

    return json({ ok: true, creditedCents: credited, opened });
  }

  // ── sign up ──
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const method = ['credit', 'venmo', 'card'].includes(body.paymentMethod) ? body.paymentMethod : null;
    if (body.invitedBy) person.invitedBy = String(body.invitedBy).slice(0, 80);

    // Already in (roster/pending)? nothing to do. On the waitlist? Grab the open
    // spot if one's available (the first-come-first-serve case), else stay put.
    const existing = findEntry(signups, email);
    let entry;
    if (existing && existing.list !== 'waitlist') {
      await setSignups(signups);
      return json({ ok: true, status: existing.list, message: "You're already on this ladder." });
    }
    if (existing && existing.list === 'waitlist') {
      if (spotsLeft(event, signups) <= 0) {
        await setSignups(signups);
        return json({ ok: true, status: 'waitlist', message: "You're on the waitlist." });
      }
      entry = moveWaitlistToRoster(signups, { playerId, email });
    } else {
      const res = addSignup(signups, event, person);
      if (res.list === 'waitlist') {
        await setSignups(signups);
        return json({ ok: true, status: 'waitlist', position: res.position });
      }
      entry = signups.roster[signups.roster.length - 1];
    }
    const feeCents = Number(event.feeCents) || 0;

    if (method === 'credit') {
      try {
        await spend(email, feeCents, `Entry · ${event.name}`, { eventId, key: `pay:${eventId}:${normalizeEmail(email)}` });
      } catch {
        // not enough credit — undo the roster add and tell them
        removeFromRoster(signups, { playerId, email });
        await setSignups(signups);
        return json({ error: 'Not enough ladder credit.' }, 402);
      }
      entry.paymentMethod = 'credit'; entry.paymentStatus = 'paid'; entry.amountCents = 0; entry.heldUntil = null;
      await setSignups(signups);
      await sendEmail({ to: email, subject: `You're in — ${event.name}`, html: renderLadderConfirmed({ playerName: person.name, eventName: event.name, dateLine: dateLineOf(event) }) }).catch(() => {});
      return json({ ok: true, status: 'in', paid: 'credit' });
    }

    if (method === 'venmo') {
      entry.paymentMethod = 'venmo'; entry.paymentStatus = 'venmo_pending'; entry.amountCents = feeCents;
      await setSignups(signups);
      // email the organizer(s) a one-tap confirm/decline
      const note = `${event.name} — ${person.name.split(' ')[0]}`;
      const confirmTok = await createLadderToken({ type: 'venmo-confirm', eventId, playerId, email, ttlMs: 7 * 24 * 3600 * 1000 });
      const declineTok = await createLadderToken({ type: 'venmo-decline', eventId, playerId, email, ttlMs: 7 * 24 * 3600 * 1000 });
      const orgs = organizerEmails(event);
      if (!orgs.length) console.warn(`[ladder-signup] Venmo claim for ${event.name} (${eventId}) has NO organizer recipient — set organizers on the ladder or LADDER_ORGANIZER_EMAILS/EMAIL_ADMIN_BCC. Admin can still confirm in the manage panel.`);
      const html = renderVenmoClaimToAdmin({
        playerName: person.name, amountLabel: fmtCents(feeCents), eventName: event.name, note,
        confirmUrl: venmoConfirmUrl(confirmTok), declineUrl: venmoDeclineUrl(declineTok),
      });
      await Promise.allSettled(orgs.map(to => sendEmail({ to, subject: `Venmo claim: ${person.name.split(' ')[0]} · ${fmtCents(feeCents)} · ${event.name}`, html })));
      return json({ ok: true, status: 'venmo_pending', venmoHandle: event.venmoHandle || null, amountCents: feeCents, note });
    }

    if (method === 'card') {
      // Stripe Checkout (entry + 10% surcharge) is handled by ladder-checkout.js
      // [[ladder-checkout]] — reuses the register-checkout/stripe-webhook pattern.
      entry.paymentMethod = 'card'; entry.paymentStatus = 'pending'; entry.amountCents = cardTotalCents(feeCents);
      await setSignups(signups);
      return json({ ok: true, status: 'roster', next: 'checkout', amountCents: cardTotalCents(feeCents), checkoutUrl: `/.netlify/functions/ladder-checkout?event=${encodeURIComponent(eventId)}` });
    }

    // no method given — reserved as pending, client will pick payment
    await setSignups(signups);
    return json({ ok: true, status: 'roster', next: 'choose-payment' });
  }

  return new Response('Method not allowed', { status: 405 });
};

async function notifyPromoted(event, next) {
  try {
    if (next.autoClaimed) {
      await sendEmail({ to: next.email, subject: `You're in — a spot opened for ${event.name}`, html: renderLadderConfirmed({ playerName: next.name, eventName: event.name, dateLine: dateLineOf(event) }) });
    } else {
      const tok = await createLadderToken({ type: 'claim', eventId: event.id, playerId: next.playerId, email: next.email, ttlMs: HOLD_MS });
      await sendEmail({ to: next.email, subject: `A spot opened for ${event.name}`, html: renderLadderSpotOpened({ playerName: next.name, eventName: event.name, dateLine: dateLineOf(event), minutesLeft: 30, claimUrl: claimUrl(tok) }) });
    }
  } catch (e) { console.warn('[ladder-signup] promote notify failed:', e?.message || e); }
}

// Final-24h: a spot opened first-come-first-serve — tell the whole waitlist.
async function notifyFcfs(event, signups) {
  const openUrl = `${siteUrl()}/ladders?event=${encodeURIComponent(event.id)}`;
  const html = renderLadderFcfsOpen({ eventName: event.name, dateLine: dateLineOf(event), openUrl });
  const recips = (signups.waitlist || []).map(w => w.email).filter(Boolean);
  await Promise.allSettled(recips.map(to => sendEmail({ to, subject: `Spot open (first come, first served) — ${event.name}`, html })));
}

function publicEvent(e) {
  return {
    id: e.id, name: e.name, date: e.date, startTime: e.startTime, place: e.place,
    courts: e.courts, capacity: e.capacity, feeCents: e.feeCents,
    paymentMethods: e.paymentMethods || ['card', 'venmo'], venmoHandle: e.venmoHandle || null,
    status: e.status || 'open',
  };
}

export const config = { path: '/.netlify/functions/ladder-signup' };
