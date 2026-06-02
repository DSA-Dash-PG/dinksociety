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
import { sendEmail } from './lib/email.js';

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
    if (path === 'team' && (!team?.name || !team?.players?.[0]?.email)) {
      return new Response('Team registration requires team name and captain email', { status: 400 });
    }
    if (path === 'agent' && (!agent?.name || !agent?.email)) {
      return new Response('Free agent registration requires name and email', { status: 400 });
    }

    // Look up the season to get the Stripe price ID (if seasonId provided)
    const seasonStore = getStore('seasons');
    let stripePriceId = null;
    let resolvedPrice = path === 'team' ? 650 : 75; // fallback
    let season = null;

    if (seasonId) {
      const seasonRaw = await seasonStore.get(seasonId);

      if (seasonRaw) {
        season = JSON.parse(seasonRaw);

        // Check registration is open
        if (season.registration !== 'open') {
          return new Response('Registration is not currently open for this season', { status: 400 });
        }

        const div = season.divisions.find(d => d.id === division);
        if (div) {
          stripePriceId = path === 'team' ? div.stripeTeamPriceId : div.stripeAgentPriceId;
          resolvedPrice = path === 'team' ? div.teamPrice : div.agentPrice;

          // ── Pay-later bypass ──────────────────────────────────
          // If the division has payLater enabled, skip Stripe entirely.
          // Create a confirmed registration + team record immediately so
          // the captain can access the portal right away.
          if (div.payLater && path === 'team') {
            const regId = crypto.randomBytes(8).toString('hex');
            const siteUrl = process.env.SITE_URL || `https://${process.env.URL || 'localhost:8888'}`;

            const registration = {
              id: regId,
              seasonId: seasonId || null,
              circuit: circuit || seasonId,
              division,
              divisionLabel: divisionLabel || division,
              path,
              status: 'confirmed',
              paymentStatus: 'pay_later',
              price: resolvedPrice,
              totalPrice: resolvedPrice,
              paymentType: 'pay_later',
              depositAmount: 0,
              balanceDue: resolvedPrice,
              balanceDueDate: null,
              team,
              createdAt: new Date().toISOString(),
              confirmedAt: new Date().toISOString(),
            };

            const regStore = getStore('registrations');
            await regStore.set(`confirmed/${regId}.json`, JSON.stringify(registration));

            // Create the team record so captain magic-link login works immediately
            const teamsStore = getStore('teams');
            const teamId = `team_${regId}`;
            const captainEmail = (team.players?.[0]?.email || '').toLowerCase().trim();
            await teamsStore.setJSON(`team/${teamId}.json`, {
              id: teamId,
              name: team.name,
              captainName: team.captain || null,
              captainEmail: captainEmail || null,
              division,
              divisionLabel: divisionLabel || division,
              circuit: circuit || 'I',
              roster: (team.players || []).map((p, i) => ({
                id: `p_${regId}_${i}`,
                name: p.name || '',
                gender: '',
                email: p.email || '',
                phone: p.phone || '',
                dupr: '',
              })),
              registrationId: regId,
              createdAt: new Date().toISOString(),
              status: 'active',
            });

            // Send a confirmation email (no payment summary since pay-later)
            if (captainEmail) {
              try {
                await sendEmail({
                  to: captainEmail,
                  subject: `You're registered — ${circuit || 'Dink Society'} (payment pending)`,
                  html: `
                    <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
                      <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#f5f5f5;margin-bottom:32px;">THE DINK SOCIETY</div>
                      <h1 style="font-size:24px;font-weight:800;text-transform:uppercase;color:#f5f5f5;margin:0 0 8px;">You're in${team.captain ? ', ' + team.captain.split(' ')[0] : ''}.</h1>
                      <p style="font-size:15px;color:#8a8a8a;line-height:1.6;margin:0 0 24px;">
                        Your team <strong style="color:#f5f5f5;">${team.name}</strong> is registered for <strong style="color:#f5f5f5;">${circuit || 'the league'}</strong> (${divisionLabel || division}).
                      </p>
                      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #ffb400;padding:16px 20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
                        <p style="font-size:14px;margin:0;line-height:1.6;color:#8a8a8a;">
                          <strong style="color:#f5f5f5;">Payment pending:</strong> Your team fee of $${resolvedPrice} will be collected separately before the season starts. Your spot is confirmed in the meantime.
                        </p>
                      </div>
                      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #b8ff2c;padding:20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
                        <p style="font-size:14px;margin:0 0 12px;line-height:1.6;color:#8a8a8a;">
                          <strong style="color:#f5f5f5;">Next step:</strong> Complete your roster through the captain portal. Request a magic link at:
                        </p>
                        <a href="${siteUrl}/captain.html" style="color:#b8ff2c;font-weight:600;text-decoration:none;">${siteUrl}/captain.html</a>
                      </div>
                      <div style="margin-top:40px;padding-top:20px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">
                        The Dink Society · Southern California Pickleball League
                      </div>
                    </div>
                  `,
                });
              } catch (emailErr) {
                console.error('Pay-later confirmation email failed:', emailErr);
              }
            }

            return new Response(JSON.stringify({ confirmationUrl: `${siteUrl}/register-success.html?id=${regId}` }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          // ─────────────────────────────────────────────────────
        }
      }
    }

    // ── Deposit model ──────────────────────────────────────────
    // Teams pay a deposit now; the remaining team fee is tracked as a
    // balance collected separately before the season. Agents pay in full.
    const isTeam = path === 'team';
    let depositAmount = 100;
    let balanceDueDate = null;
    // Season blob is the authoritative source; fall back to circuit-settings for legacy data.
    if (season && season.depositAmount != null) {
      depositAmount = Number(season.depositAmount);
      balanceDueDate = season.balanceDueDate || null;
    } else {
      try {
        const configStore = getStore({ name: 'config', consistency: 'strong' });
        const cfgRaw = await configStore.get('circuit-settings');
        if (cfgRaw) {
          const cfg = JSON.parse(cfgRaw);
          if (cfg.depositAmount != null) depositAmount = Number(cfg.depositAmount);
          if (cfg.balanceDueDate) balanceDueDate = cfg.balanceDueDate;
        }
      } catch (e) {
        console.warn('Could not load circuit-settings for deposit; using defaults:', e.message);
      }
    }

    const totalPrice = resolvedPrice;
    // Agents pay in full; clamp the deposit so it never exceeds the total.
    if (!isTeam || !(depositAmount > 0) || depositAmount > totalPrice) {
      depositAmount = totalPrice;
    }
    const amountDueNow = depositAmount;
    const balanceDue = Math.max(0, totalPrice - amountDueNow);

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
      price: totalPrice,
      totalPrice: totalPrice,
      paymentType: isTeam ? 'deposit' : 'full',
      depositAmount: amountDueNow,
      balanceDue: balanceDue,
      balanceDueDate: balanceDue > 0 ? balanceDueDate : null,
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

    // Teams are billed the deposit now via an inline price. The full-price
    // Stripe price ID is only used when the whole amount is due at checkout
    // (free agents).
    if (isTeam) {
      sessionParams.line_items = [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Dink Society — Team Registration Deposit (${divisionLabel || division})`,
            description: `${circuit || 'Dink Society'} · ${divisionLabel || division} · $${amountDueNow} deposit toward the $${totalPrice} team fee`,
          },
          unit_amount: Math.round(amountDueNow * 100),
        },
        quantity: 1,
      }];
    } else if (stripePriceId) {
      sessionParams.line_items = [{
        price: stripePriceId,
        quantity: 1,
      }];
    } else {
      // Fallback: create an inline price (works even without admin-created Stripe products)
      sessionParams.line_items = [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Dink Society — Free Agent Registration (${divisionLabel || division})`,
            description: `${circuit || 'Dink Society'} · ${divisionLabel || division}`,
          },
          unit_amount: Math.round(totalPrice * 100),
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
