// =============================================================
// POST /api/register-checkout
//
// Creates a Stripe Checkout Session for league registration.
//
// Payload from register.html:
//   { seasonId, circuit, division, divisionLabel, path, price,
//     team?: { name, captain, players: [{ name, email, phone?, role }] },
//     agent?: { name, email, gender, dob?, dupr? } }
//
// Flow:
//   1. Looks up the season from Blobs to get the Stripe price ID
//   2. Creates a pending registration record in Blobs
//   3. Creates a Stripe Checkout Session with the correct price
//   4. Returns { checkoutUrl } for the frontend to redirect
//
// The stripe-webhook function handles checkout.session.completed
// and marks the registration as 'confirmed'.
//
// KEY FORMAT: pending/{id}.json → confirmed/{id}.json
// =============================================================

import Stripe from 'stripe';
import { getStore } from '@netlify/blobs';
import crypto from 'crypto';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response('Stripe not configured', { status: 500 });
  }

  try {
    const body = await req.json();
    const { seasonId, circuit, division, divisionLabel, path, team, agent } = body;

    // Validate required fields (seasonId is optional — falls back to circuit)
    if (!division || !path) {
      return new Response('Missing required fields: division, path', { status: 400 });
    }
    if (path === 'team' && (!team?.name || !team?.players?.length)) {
      return new Response('Team registration requires team name and at least one player', { status: 400 });
    }
    if (path === 'agent' && (!agent?.name || !agent?.email)) {
      return new Response('Free agent registration requires name and email', { status: 400 });
    }

    // Look up the season to get the Stripe price ID (if seasonId provided)
    const seasonStore = getStore('seasons');
    let stripePriceId = null;
    let resolvedPrice = path === 'team' ? 450 : 75; // fallback

    if (seasonId) {
      const seasonRaw = await seasonStore.get(seasonId);

      if (seasonRaw) {
        const season = JSON.parse(seasonRaw);

        // Check registration is open
        if (season.registration !== 'open') {
          return new Response('Registration is not currently open for this season', { status: 400 });
        }

        const div = season.divisions.find(d => d.id === division);
        if (div) {
          stripePriceId = path === 'team' ? div.stripeTeamPriceId : div.stripeAgentPriceId;
          resolvedPrice = path === 'team' ? div.teamPrice : div.agentPrice;
        }
      }
    }

    // Generate a registration ID
    const regId = crypto.randomBytes(8).toString('hex');

    // Create the registration record (pending until payment confirms)
    const registration = {
      id: regId,
      seasonId: seasonId || null,
      circuit: circuit || seasonId,
      division,
      divisionLabel: divisionLabel || division,
      path,
      status: 'pending',
      price: resolvedPrice,
      team: path === 'team' ? team : undefined,
      agent: path === 'agent' ? agent : undefined,
      createdAt: new Date().toISOString(),
    };

    // Save to Blobs with prefixed key: pending/{id}.json
    const regStore = getStore('registrations');
    const pendingKey = `pending/${regId}.json`;
    await regStore.set(pendingKey, JSON.stringify(registration));

    // Build the Stripe Checkout Session
    const stripe = new Stripe(stripeKey);
    const siteUrl = process.env.SITE_URL || `https://${process.env.URL || 'localhost:8888'}`;

    const customerEmail = path === 'team'
      ? team?.players?.[0]?.email
      : agent?.email;

    const sessionParams = {
      mode: 'payment',
      success_url: `${siteUrl}/register-success.html?id=${regId}`,
      cancel_url: `${siteUrl}/register.html`,
      customer_email: customerEmail || undefined,
      metadata: {
        registrationId: regId,
        seasonId: seasonId || '',
        division,
        path,
      },
    };

    // Use the Stripe price ID from the season if available,
    // otherwise fall back to price_data (inline pricing)
    if (stripePriceId) {
      sessionParams.line_items = [{
        price: stripePriceId,
        quantity: 1,
      }];
    } else {
      // Fallback: create an inline price (works even without admin-created Stripe products)
      const displayName = path === 'team'
        ? `Dink Society — Team Registration (${divisionLabel || division})`
        : `Dink Society — Free Agent Registration (${divisionLabel || division})`;

      sessionParams.line_items = [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: displayName,
            description: `${circuit || 'Dink Society'} · ${divisionLabel || division}`,
          },
          unit_amount: Math.round(resolvedPrice * 100),
        },
        quantity: 1,
      }];
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Update registration with Stripe session ID
    registration.stripeSessionId = session.id;
    await regStore.set(pendingKey, JSON.stringify(registration));

    return new Response(JSON.stringify({ checkoutUrl: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('register-checkout error:', err);
    return new Response(err.message || 'Server error', { status: 500 });
  }
};
