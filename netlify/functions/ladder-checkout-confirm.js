// netlify/functions/ladder-checkout-confirm.js
// POST/GET /api/ladder-checkout-confirm?session_id=<stripe_cs_id>
//
// Reconciles a card / Apple Pay payment from the Stripe Checkout success redirect.
// This is a safety net so a paid spot flips to `paid` even when the Stripe webhook
// is misconfigured or delayed. Idempotent: if already paid, it just confirms.

import Stripe from 'stripe';
import { normalizeEmail } from './lib/identity.js';
import { getEvent, getSignups, setSignups } from './lib/ladder.js';
import { dateLineOf, cancelLinkFor } from './lib/ladder-notify.js';
import { sendEmail, renderLadderConfirmed } from './lib/email.js';
import { notifyOrganizersPaid } from './ladder-stripe-webhook.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

export default async (req) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ ok: false, error: 'Stripe not configured' }, 500);

  const sessionId = new URL(req.url).searchParams.get('session_id');
  if (!sessionId) return json({ ok: false, error: 'session_id required' }, 400);

  const stripe = new Stripe(stripeKey);
  let cs;
  try { cs = await stripe.checkout.sessions.retrieve(sessionId); }
  catch (e) { return json({ ok: false, error: 'Could not retrieve session' }, 400); }

  if (cs.metadata?.ladder !== '1') return json({ ok: false, error: 'Not a ladder session' }, 400);
  if (cs.payment_status !== 'paid') return json({ ok: false, pending: true });

  const { eventId, playerId, email } = cs.metadata || {};
  if (!eventId) return json({ ok: false, error: 'No eventId' }, 400);

  const ladderEvent = await getEvent(eventId);
  const signups = await getSignups(eventId);
  const norm = normalizeEmail(email);
  const entry = signups.roster.find(p =>
    (playerId && p.playerId === playerId) || (norm && normalizeEmail(p.email) === norm));
  if (!entry) return json({ ok: false, error: 'Roster entry not found' }, 404);

  // Already reconciled (likely by the webhook) → nothing more to do.
  if (entry.paymentStatus === 'paid') return json({ ok: true, paid: true, already: true });

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

  return json({ ok: true, paid: true });
};

export const config = { path: '/.netlify/functions/ladder-checkout-confirm' };
