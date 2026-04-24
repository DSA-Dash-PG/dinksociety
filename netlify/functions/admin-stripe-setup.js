// =============================================================
// POST /api/admin-stripe-setup
//
// Creates Stripe products and prices for a season's divisions.
// Called when admin opens registration for a season.
//
// Input: { seasonId }
// 
// For each division without Stripe price IDs, creates:
//   - A Stripe product for the division
//   - Two prices: team price and agent price
//   - Stores the price IDs back on the division record
//
// Idempotent: skips divisions that already have Stripe IDs.
// =============================================================

import Stripe from 'stripe';
import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    await requireAdmin(req);
  } catch {
    return unauthResponse();
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return json({ error: 'STRIPE_SECRET_KEY not configured' }, 500);
  }

  const stripe = new Stripe(stripeKey);
  const { seasonId } = await req.json();

  if (!seasonId) return json({ error: 'seasonId is required' }, 400);

  const store = getStore('seasons');
  const raw = await store.get(seasonId);
  if (!raw) return json({ error: 'Season not found' }, 404);

  const season = JSON.parse(raw);

  if (!season.divisions.length) {
    return json({ error: 'Season has no divisions. Add divisions first.' }, 400);
  }

  const results = [];

  for (const div of season.divisions) {
    // Skip if already set up
    if (div.stripeTeamPriceId && div.stripeAgentPriceId) {
      results.push({ division: div.name, status: 'already-configured' });
      continue;
    }

    try {
      // Create product
      const product = await stripe.products.create({
        name: `${season.name} — ${div.name}`,
        description: `Dink Society ${season.name}, ${div.name} division`,
        metadata: {
          seasonId: season.id,
          divisionId: div.id,
        },
      });

      // Create team price
      const teamPrice = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(div.teamPrice * 100), // cents
        currency: 'usd',
        metadata: {
          type: 'team',
          seasonId: season.id,
          divisionId: div.id,
        },
      });

      // Create agent price
      const agentPrice = await stripe.prices.create({
        product: product.id,
        unit_amount: Math.round(div.agentPrice * 100),
        currency: 'usd',
        metadata: {
          type: 'agent',
          seasonId: season.id,
          divisionId: div.id,
        },
      });

      // Update division with Stripe IDs
      div.stripeProductId = product.id;
      div.stripeTeamPriceId = teamPrice.id;
      div.stripeAgentPriceId = agentPrice.id;

      results.push({
        division: div.name,
        status: 'created',
        productId: product.id,
        teamPriceId: teamPrice.id,
        agentPriceId: agentPrice.id,
      });
    } catch (err) {
      console.error(`Stripe setup failed for ${div.name}:`, err);
      results.push({
        division: div.name,
        status: 'error',
        error: err.message,
      });
    }
  }

  // Save updated season
  season.updatedAt = new Date().toISOString();
  await store.set(seasonId, JSON.stringify(season));

  return json({ ok: true, results, season });
};
