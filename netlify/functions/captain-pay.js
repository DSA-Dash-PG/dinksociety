// netlify/functions/captain-pay.js
// Creates a Stripe Checkout Session for a team's outstanding balance, initiated
// from the captain portal. POST /.netlify/functions/captain-pay
//
// The registration is already confirmed; stripe-webhook.js records the payment
// against it (metadata.paymentType === 'balance').

import Stripe from 'stripe';
import { getStore } from '@netlify/blobs';
import { requireCaptain, unauthResponse } from './lib/captain-auth.js';

async function findRegistration(regStore, id) {
  const keys = [`confirmed/${id}.json`, `pending/${id}.json`, id];
  for (const key of keys) {
    const raw = await regStore.get(key).catch(() => null);
    if (raw) {
      try { return JSON.parse(raw); } catch { return null; }
    }
  }
  return null;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const headers = { 'Content-Type': 'application/json' };
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), { status: 500, headers });
  }

  const regId = ctx.team.registrationId;
  if (!regId) {
    return new Response(JSON.stringify({ error: 'No registration linked to this team' }), { status: 400, headers });
  }

  const regStore = getStore('registrations');
  const reg = await findRegistration(regStore, regId);
  if (!reg) {
    return new Response(JSON.stringify({ error: 'Registration not found' }), { status: 404, headers });
  }

  const totalPrice = Number(reg.totalPrice ?? reg.price ?? 0);
  const amountPaid = Number(reg.amountPaid ?? 0);
  const balanceDue = Math.max(0, Number(reg.balanceDue ?? (totalPrice - amountPaid)));

  if (balanceDue <= 0) {
    return new Response(JSON.stringify({ error: 'No balance due', balanceDue: 0 }), { status: 400, headers });
  }

  try {
    const stripe = new Stripe(stripeKey);
    const siteUrl = process.env.SITE_URL || `https://${process.env.URL || 'localhost:8888'}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${siteUrl}/captain.html?paid=1`,
      cancel_url: `${siteUrl}/captain.html`,
      customer_email: ctx.team.captainEmail || undefined,
      allow_promotion_codes: true,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Dink Society — Team Fee Balance (${reg.divisionLabel || reg.division || ''})`,
            description: `${reg.circuit || 'Dink Society'} · ${ctx.team.name} · $${balanceDue} balance`,
          },
          unit_amount: Math.round(balanceDue * 100),
        },
        quantity: 1,
      }],
      metadata: {
        registrationId: regId,
        teamId: ctx.team.id,
        paymentType: 'balance',
      },
    });

    return new Response(JSON.stringify({ checkoutUrl: session.url }), { status: 200, headers });
  } catch (err) {
    console.error('captain-pay error:', err);
    return new Response(JSON.stringify({ error: err.message || 'Server error' }), { status: 500, headers });
  }
};

export const config = { path: '/.netlify/functions/captain-pay' };
