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
  cardTotalCents, surchargeCents, addPairSignup,
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

  // Respect the ladder's payment settings — a Venmo-only ladder must never
  // reach Stripe, even via a direct API call.
  const allowedMethods = Array.isArray(event.paymentMethods) && event.paymentMethods.length
    ? event.paymentMethods : ['card', 'venmo'];
  if (!allowedMethods.includes('card')) {
    return json({ error: 'Card payments are turned off for this ladder — pay by Venmo instead.' }, 400);
  }

  const body = await req.json().catch(() => ({}));
  const person = { playerId, name: player?.name || 'Player', email, gender: player?.gender || null };

  // Gender-locked ladder + DUPR-rated + Fixed Partner all apply here too —
  // this is the endpoint the live "Card / Apple Pay" button actually calls
  // (it skips ladder-signup.js's POST entirely), so it needs its own copy of
  // the same eligibility/partner/DUPR capture that endpoint does.
  const genderLock = event.type === 'mens' ? 'M' : event.type === 'womens' ? 'F' : null;
  const genderErr = (g, who) => {
    const gg = String(g || '').trim().toUpperCase().charAt(0);
    if (gg === genderLock) return null;
    const label = genderLock === 'F' ? "women's" : "men's";
    return gg
      ? `This is a ${label}-only ladder, so ${who} isn't eligible.`
      : `This is a ${label}-only ladder and ${who} doesn't have a gender set yet, so we can't confirm eligibility.`;
  };
  if (genderLock) {
    const err = genderErr(person.gender, 'your registration');
    if (err) return json({ error: err }, 403);
  }
  const isPair = event.format === 'fixed-partner';
  let partner = null;
  if (isPair) {
    const pName = String(body.partner?.name || '').trim();
    if (!pName) return json({ error: "Enter your partner's name — this is a Fixed Partner ladder, so you register as a pair." }, 400);
    const pEmail = String(body.partner?.email || '').trim().toLowerCase();
    if (!pEmail) return json({ error: "Enter your partner's email." }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pEmail)) return json({ error: "Enter a valid email for your partner." }, 400);
    partner = {
      name: pName.slice(0, 80),
      gender: body.partner?.gender === 'F' ? 'F' : (body.partner?.gender === 'M' ? 'M' : null),
      email: pEmail,
    };
    if (genderLock) {
      const err = genderErr(partner.gender, `your partner (${partner.name})`);
      if (err) return json({ error: err }, 403);
    }
  }
  if (event.duprRated) {
    const dId = String(body.duprId || '').trim();
    if (!dId) return json({ error: 'Enter your DUPR ID — this is a DUPR-rated ladder.' }, 400);
    person.duprId = dId.slice(0, 40);
    if (isPair) {
      const pd = String(body.partner?.duprId || '').trim();
      if (!pd) return json({ error: "Enter your partner's DUPR ID — this is a DUPR-rated ladder." }, 400);
      partner.duprId = pd.slice(0, 40);
    }
  }

  const signups = await getSignups(eventId);

  // Ensure the player (and, for a Fixed Partner ladder, their linked partner)
  // holds a roster spot — this endpoint can also be the entry point, not just
  // a follow-up to ladder-signup. If full, no checkout.
  let existing = findEntry(signups, email);
  let partnerEntry = null;
  if (isPair) {
    if (!existing) {
      if (spotsLeft(event, signups) < 2) return json({ error: 'This ladder doesn\'t have 2 open spots for your pair — join the waitlist instead.' }, 409);
      const res = addPairSignup(signups, event, person, partner);
      partnerEntry = res.partnerEntry;
    }
  } else if (!existing || existing.list === 'waitlist') {
    if (spotsLeft(event, signups) <= 0) {
      return json({ error: 'This ladder is full — join the waitlist instead.' }, 409);
    }
    if (!existing) {
      addSignup(signups, event, person);
    }
  }
  const entry = signups.roster.find(p => p.email === email || p.playerId === playerId);
  if (!entry) return json({ error: 'Could not reserve a spot.' }, 409);
  if (isPair && !partnerEntry) partnerEntry = signups.roster.find(p => p.playerId === entry.partnerId) || null;

  const feeCents = (Number(event.feeCents) || 0) * (isPair ? 2 : 1);
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
  if (partnerEntry) { partnerEntry.paymentMethod = 'card'; partnerEntry.paymentStatus = 'pending'; partnerEntry.amountCents = 0; partnerEntry.checkoutSessionId = checkout.id; }
  await setSignups(signups);

  return json({ checkoutUrl: checkout.url, amountCents, surchargeCents: surchargeCents(feeCents) });
};

export const config = { path: '/.netlify/functions/ladder-checkout' };
