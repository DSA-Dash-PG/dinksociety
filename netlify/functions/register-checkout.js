// netlify/functions/register-checkout.js
// Creates a Stripe Checkout Session for a Dink Society Circuit I registration.
// Stashes the pending registration in Netlify Blobs so the webhook can retrieve it
// and mark it confirmed once payment succeeds.
//
// Required env vars (set in Netlify dashboard):
//   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
//   STRIPE_SUCCESS_URL     — e.g. https://justdinkit.netlify.app/register-success.html
//   STRIPE_CANCEL_URL      — e.g. https://justdinkit.netlify.app/register.html
//   SITE_URL               — used as fallback if the two above aren't set

import { getStore } from '@netlify/blobs';
import Stripe from 'stripe';

const PRICES = {
  team: 45000,   // cents
  agent: 7500,
};

const DIVISION_LABELS = {
  '3.0M': '3.0 Mixed',
  '3.5M': '3.5 Mixed',
  '3.5W': "3.5 Women's",
};

export default async (req, context) => {
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers,
    });
  }

  try {
    const body = await req.json();
    const { path, division, circuit, team, agent } = body;

    // ===== Validate =====
    if (!['team', 'agent'].includes(path)) {
      return json({ error: 'Invalid path' }, 400, headers);
    }
    if (!Object.keys(DIVISION_LABELS).includes(division)) {
      return json({ error: 'Invalid division' }, 400, headers);
    }
    if (division === '3.5W') {
      return json({ error: "3.5 Women's division is not yet open for registration" }, 400, headers);
    }
    if (!circuit || !/^[IVX]+$/.test(circuit)) {
      return json({ error: 'Invalid circuit' }, 400, headers);
    }

    if (path === 'team') {
      if (!team?.name) {
        return json({ error: 'Team must have a name' }, 400, headers);
      }
      if (!team?.captainName || !team?.captainEmail) {
        return json({ error: 'Captain name and email are required' }, 400, headers);
      }
    } else {
      if (!agent?.name || !agent?.email) {
        return json({ error: 'Free-agent registration needs a name and email' }, 400, headers);
      }
    }

    // ===== Stash pending registration =====
    const registrationId = cryptoId();
    const store = getStore('registrations');
    const pending = {
      id: registrationId,
      circuit,
      division,
      divisionLabel: DIVISION_LABELS[division],
      path,
      team: team || null,
      agent: agent || null,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await store.setJSON(`pending/${registrationId}.json`, pending);

    // ===== Stripe Checkout =====
    const stripeKey = Netlify.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) {
      return json({ error: 'Stripe not configured (STRIPE_SECRET_KEY missing)' }, 500, headers);
    }
    const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

    const siteUrl = Netlify.env.get('SITE_URL') || 'https://justdinkit.netlify.app';
    const successUrl = (Netlify.env.get('STRIPE_SUCCESS_URL') || `${siteUrl}/register-success.html`)
      + `?id=${registrationId}&session={CHECKOUT_SESSION_ID}`;
    const cancelUrl = Netlify.env.get('STRIPE_CANCEL_URL') || `${siteUrl}/register.html`;

    const customerEmail = path === 'team' ? team.captainEmail : agent.email;
    const productName = path === 'team'
      ? `The Dink Society — Circuit ${circuit} team entry (${DIVISION_LABELS[division]})`
      : `The Dink Society — Circuit ${circuit} free agent (${DIVISION_LABELS[division]})`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: customerEmail,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: PRICES[path],
          product_data: {
            name: productName,
            description: path === 'team'
              ? `Team: ${team.name} · Captain: ${team.captainName}`
              : `Free agent: ${agent.name}`,
          },
        },
        quantity: 1,
      }],
      metadata: {
        registrationId,
        circuit,
        division,
        path,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return json({ checkoutUrl: session.url, registrationId }, 200, headers);
  } catch (err) {
    console.error('register-checkout error:', err);
    return json({ error: 'Checkout failed', detail: err.message }, 500, headers);
  }
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function cryptoId() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const config = { path: '/.netlify/functions/register-checkout' };
