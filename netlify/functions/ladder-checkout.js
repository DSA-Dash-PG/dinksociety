// netlify/functions/ladder-checkout.js
// POST /api/ladder-checkout?event=<id>   (player session required)
//
// Creates a Stripe Checkout Session for a ladder spot paid by CARD — entry fee
// plus a flat 10% service fee (covers Stripe's ~2.9% + 30¢). Mirrors the
// register-checkout.js pattern. The signup is reserved on the roster as
// `pending` here; ladder-stripe-webhook.js flips it to `paid` on success.
//
// Returns { checkoutUrl } for the frontend to redirect to.

import Stripe from 'stripe';
import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import {
  getEvent, getSignups, setSignups, findEntry, addSignup, spotsLeft,
  cardTotalCents, surchargeCents,
} from './lib/ladder.js';
import { siteUrl, dateLineOf, fmtCents } from './lib/ladder-notify.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return json({ error: 'Stripe not configured' }, 500);

  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);

  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const { playerId, player, session } = verified.payload;
  const email = (session?.email || player?.email || '').toLowerCase();

  const event = await getEvent(eventId);
  if (!event) return json({ error: 'Ladder not found' }, 404);

  const signups = await getSignups(eventId);

  // Ensure the player holds a roster spot (this endpoint can also be the entry
  // point, not just a follow-up to ladder-signup). If full, no checkout.
  let existing = findEntry(signups, email);
  if (!existing || existing.list === 'waitlist') {
    if (spotsLeft(event, signups) <= 0) {
      return json({ error: 'This ladder is full — join the waitlist instead.' }, 409);
    }
    if (!existing) {
      addSignup(signups, event, { playerId, name: player?.name || 'Player', email, gender: player?.gender || null });
    }
  }
  const entry = signups.roster.find(p => p.email === email || p.playerId === playerId);
  if (!entry) return json({ error: 'Could not reserve a spot.' }, 409);

  const feeCents = Number(event.feeCents) || 0;
  const amountCents = cardTotalCents(feeCents);

  const stripe = new Stripe(stripeKey);
  const base = siteUrl();
  const sessionParams = {
    mode: 'payment',
    success_url: `${base}/ladders?event=${encodeURIComponent(eventId)}&paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/ladders?event=${encodeURIComponent(eventId)}`,
    customer_email: email || undefined,
    metadata: { ladder: '1', eventId, playerId: playerId || '', email },
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `Ladder entry — ${event.name}`,
          description: `${dateLineOf(event)} · ${fmtCents(feeCents)} entry + 10% service fee`,
        },
        unit_amount: amountCents,
      },
      quantity: 1,
    }],
  };

  const checkout = await stripe.checkout.sessions.create(sessionParams);

  entry.paymentMethod = 'card';
  entry.paymentStatus = 'pending';
  entry.amountCents = amountCents;
  entry.checkoutSessionId = checkout.id;
  await setSignups(signups);

  return json({ checkoutUrl: checkout.url, amountCents, surchargeCents: surchargeCents(feeCents) });
};

export const config = { path: '/.netlify/functions/ladder-checkout' };
