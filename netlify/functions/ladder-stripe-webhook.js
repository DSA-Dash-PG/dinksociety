// netlify/functions/ladder-stripe-webhook.js
// POST /api/ladder-stripe-webhook
//
// Stripe webhook for LADDER card payments. On checkout.session.completed for a
// ladder session (metadata.ladder === '1'), flips the player's roster entry to
// paid and emails them confirmation. Separate endpoint + signing secret from the
// registration webhook so the two never interfere.
//
// Env: STRIPE_SECRET_KEY, LADDER_STRIPE_WEBHOOK_SECRET (falls back to
// STRIPE_WEBHOOK_SECRET if you register a single endpoint for both).

import Stripe from 'stripe';
import { normalizeEmail } from './lib/identity.js';
import { getEvent, getSignups, setSignups } from './lib/ladder.js';
import { dateLineOf, organizerEmails, fmtCents, cancelLinkFor } from './lib/ladder-notify.js';
import { sendEmail, renderLadderConfirmed } from './lib/email.js';

// Plain notification to organizers that someone registered + paid.
export function notifyOrganizersPaid(ladderEvent, entry) {
  const orgs = organizerEmails(ladderEvent || {});
  if (!orgs.length) return Promise.resolve();
  const html = `<div style="font-family:system-ui,Arial,sans-serif"><h2 style="margin:0 0 8px">New ladder signup — paid</h2>
    <p style="margin:0 0 4px"><b>${entry.name || 'Player'}</b> registered for <b>${ladderEvent?.name || 'your ladder'}</b>.</p>
    <p style="margin:0 0 4px">${dateLineOf(ladderEvent || {})}</p>
    <p style="margin:0 0 4px">Paid by ${entry.paymentMethod || 'card'} · ${fmtCents(entry.amountCents || 0)}${entry.email ? ' · ' + entry.email : ''}</p></div>`;
  return Promise.allSettled(orgs.map(to => sendEmail({ to, subject: `New signup: ${(entry.name || 'Player').split(' ')[0]} · ${ladderEvent?.name || 'ladder'}`, html })));
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.LADDER_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripeKey || !webhookSecret) {
    console.error('[ladder-webhook] missing STRIPE_SECRET_KEY or webhook secret');
    return new Response('Server misconfigured', { status: 500 });
  }

  const stripe = new Stripe(stripeKey);
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error('[ladder-webhook] signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const cs = event.data.object;
    // Ignore anything that isn't one of ours (e.g. registration sessions).
    if (cs.metadata?.ladder !== '1') return ok();

    const { eventId, playerId, email } = cs.metadata || {};
    if (!eventId) { console.warn('[ladder-webhook] no eventId in metadata'); return ok(); }

    try {
      const ladderEvent = await getEvent(eventId);
      const signups = await getSignups(eventId);
      const norm = normalizeEmail(email);
      const entry = signups.roster.find(p =>
        (playerId && p.playerId === playerId) || (norm && normalizeEmail(p.email) === norm));

      if (!entry) { console.warn(`[ladder-webhook] roster entry not found for ${email} on ${eventId}`); return ok(); }

      // Idempotent: if already paid, do nothing further.
      if (entry.paymentStatus !== 'paid') {
        entry.paymentStatus = 'paid';
        entry.paymentMethod = 'card';
        entry.amountCents = cs.amount_total ?? entry.amountCents ?? null;
        entry.checkoutSessionId = cs.id;
        entry.heldUntil = null;
        await setSignups(signups);

        if (entry.email) {
          await sendEmail({
            to: entry.email,
            subject: `You're in — ${ladderEvent?.name || 'your ladder'}`,
            html: renderLadderConfirmed({ playerName: entry.name, eventName: ladderEvent?.name || 'your ladder', dateLine: dateLineOf(ladderEvent || {}), cancelUrl: await cancelLinkFor(ladderEvent, { playerId: entry.playerId, email: entry.email }) }),
          }).catch(() => {});
        }
        await notifyOrganizersPaid(ladderEvent, entry).catch(() => {});
        console.log(`[ladder-webhook] ${entry.email} paid for ${eventId} ($${(entry.amountCents || 0) / 100})`);
      }
    } catch (err) {
      console.error('[ladder-webhook] error handling session:', err);
    }
  }

  return ok();
};

function ok() {
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/.netlify/functions/ladder-stripe-webhook' };
