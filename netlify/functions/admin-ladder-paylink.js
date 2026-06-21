// netlify/functions/admin-ladder-paylink.js
// POST /api/admin-ladder-paylink?event=<id>   (admin session required)
//   body { playerId?, email? }
//
// Emails a payment request to a player an organizer manually added to a ladder.
// Shows whichever methods the ladder accepts:
//   • Card  — a one-tap Stripe Checkout link (entry + 10% service fee). The spot
//             is marked pending/card here; ladder-stripe-webhook flips it to paid.
//   • Venmo — instructions + a venmo.com deep link for the flat entry fee.
// The player's roster entry must already exist and have an email on file.

import Stripe from 'stripe';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail } from './lib/identity.js';
import { getEvent, getSignups, setSignups, cardTotalCents, surchargeCents } from './lib/ladder.js';
import { siteUrl, dateLineOf, fmtCents } from './lib/ladder-notify.js';
import { sendEmail, renderLadderPayRequest } from './lib/email.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const findRosterEntry = (s, playerId, email) => {
  const norm = normalizeEmail(email);
  return (s.roster || []).find(p => (playerId && p.playerId === playerId) || (norm && normalizeEmail(p.email) === norm));
};

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);

  const event = await getEvent(eventId);
  if (!event) return json({ error: 'Ladder not found' }, 404);

  const body = await req.json().catch(() => ({}));
  const signups = await getSignups(eventId);
  const entry = findRosterEntry(signups, body.playerId, body.email);
  if (!entry) return json({ error: 'Player not on the roster' }, 404);
  if (!entry.email) return json({ error: 'No email on file for this player' }, 400);
  if (entry.paymentStatus === 'paid') return json({ error: 'Already marked paid' }, 409);

  const feeCents = Number(event.feeCents) || 0;
  if (feeCents <= 0) return json({ error: 'This ladder is free — no payment needed' }, 400);

  const methods = Array.isArray(event.paymentMethods) && event.paymentMethods.length
    ? event.paymentMethods : ['card', 'venmo'];
  const base = siteUrl();

  // ── Card: create a Checkout session targeted at this specific player ──
  let cardUrl = null;
  const wantCard = methods.includes('card');
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (wantCard && stripeKey) {
    const stripe = new Stripe(stripeKey);
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${base}/ladders?event=${encodeURIComponent(eventId)}&paid=1`,
      cancel_url: `${base}/ladders?event=${encodeURIComponent(eventId)}`,
      customer_email: entry.email || undefined,
      metadata: { ladder: '1', eventId, playerId: entry.playerId || '', email: entry.email },
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Ladder entry — ${event.name}`,
            description: `${dateLineOf(event)} · ${fmtCents(feeCents)} entry + 10% service fee`,
          },
          unit_amount: cardTotalCents(feeCents),
        },
        quantity: 1,
      }],
    });
    cardUrl = checkout.url;
    entry.paymentMethod = entry.paymentMethod || 'card';
    entry.paymentStatus = 'pending';
    entry.amountCents = cardTotalCents(feeCents);
    entry.checkoutSessionId = checkout.id;
    await setSignups(signups);
  }

  // ── Venmo: deep link + instructions for the flat entry fee ──
  let venmoUrl = null, venmoHandle = null;
  const wantVenmo = methods.includes('venmo') && event.venmoHandle;
  if (wantVenmo) {
    venmoHandle = String(event.venmoHandle).replace(/^@/, '');
    const dollars = (feeCents / 100).toFixed(2);
    const note = event.name || 'Ladder entry';
    venmoUrl = `https://venmo.com/${encodeURIComponent(venmoHandle)}?txn=pay&amount=${dollars}&note=${encodeURIComponent(note)}`;
  }

  if (!cardUrl && !venmoUrl) {
    return json({ error: 'No payment method available (card not configured and no Venmo handle).' }, 400);
  }

  await sendEmail({
    to: entry.email,
    subject: `Pay your spot — ${event.name}`,
    html: renderLadderPayRequest({
      playerName: entry.name,
      eventName: event.name,
      dateLine: dateLineOf(event),
      cardUrl,
      cardAmountLabel: cardUrl ? fmtCents(cardTotalCents(feeCents)) : null,
      venmoHandle,
      venmoUrl,
      venmoAmountLabel: venmoUrl ? fmtCents(feeCents) : null,
      venmoNote: venmoUrl ? (event.name || 'Ladder entry') : null,
    }),
  });

  return json({
    ok: true, sent: entry.email,
    methods: [cardUrl ? 'card' : null, venmoUrl ? 'venmo' : null].filter(Boolean),
    surchargeCents: cardUrl ? surchargeCents(feeCents) : 0,
  });
};

export const config = { path: '/.netlify/functions/admin-ladder-paylink' };
