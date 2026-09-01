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
// paymentMethod: 'venmo' skips Stripe — the registration is saved as pending
// with the Venmo handle / amount / note to send, and stays pending until an
// admin confirms the deposit landed ("Venmo received" in the Registrations tab).
//
// KEY FORMAT: pending/{id}.json → confirmed/{id}.json
// =============================================================

import Stripe from 'stripe';
import { getStore } from '@netlify/blobs';
import crypto from 'crypto';
import { sendEmail } from './lib/email.js';
import { circuitCode } from './lib/circuit.js';
import { resolveDepositTerms, VENMO_HANDLE, venmoProfileUrl, fmtDueDate, CARD_PAYMENTS_ENABLED, DEFAULT_TEAM_FEE } from './lib/payment-terms.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;

  try {
    const body = await req.json();
    const { seasonId, circuit, division, divisionLabel, path, team, agent } = body;
    // 'venmo' (sent to @VENMO_HANDLE; registration stays pending until an admin
    // confirms the payment landed) or 'card' (Stripe Checkout — only when
    // CARD_PAYMENTS_ENABLED is on). Venmo is the default while card is off.
    const paymentMethod = body.paymentMethod === 'card' && CARD_PAYMENTS_ENABLED ? 'card' : 'venmo';
    // A Venmo payer chooses the deposit or the whole team fee up front.
    const payInFull = body.venmoOption === 'full';
    if (body.paymentMethod === 'card' && !CARD_PAYMENTS_ENABLED) {
      return new Response('Card payments are turned off right now — pay by Venmo instead.', { status: 400 });
    }
    if (paymentMethod === 'card' && !stripeKey) {
      return new Response('Stripe not configured', { status: 500 });
    }

    // Storage uses the canonical circuit CODE ("I"); customer-facing text uses
    // the season's display name ("Season 1"). Keeping these separate is what
    // prevents the display name from leaking into blob keys.
    const circuitStored = circuitCode(circuit || seasonId);
    let seasonName = 'Dink Society';

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
    let resolvedPrice = path === 'team' ? DEFAULT_TEAM_FEE : 75; // fallback
    let season = null;

    if (seasonId) {
      const seasonRaw = await seasonStore.get(seasonId);

      if (seasonRaw) {
        season = JSON.parse(seasonRaw);
        seasonName = season.circuitName || season.name || seasonName;

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
              circuit: circuitStored,
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
              circuit: circuitStored,
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
                  subject: `You're registered — ${seasonName} (payment pending)`,
                  html: `
                    <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
                      <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#f5f5f5;margin-bottom:32px;">THE DINK SOCIETY</div>
                      <h1 style="font-size:24px;font-weight:800;text-transform:uppercase;color:#f5f5f5;margin:0 0 8px;">You're in${team.captain ? ', ' + team.captain.split(' ')[0] : ''}.</h1>
                      <p style="font-size:15px;color:#8a8a8a;line-height:1.6;margin:0 0 24px;">
                        Your team <strong style="color:#f5f5f5;">${team.name}</strong> is registered for <strong style="color:#f5f5f5;">${seasonName}</strong> (${divisionLabel || division}).
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
    // Season blob is the authoritative source; circuit-settings is the legacy
    // fallback; the balance-due date defaults to one week before the season.
    const terms = await resolveDepositTerms(season);
    let depositAmount = terms.depositAmount;
    const balanceDueDate = terms.balanceDueDate;

    const totalPrice = resolvedPrice;
    // Agents pay in full; clamp the deposit so it never exceeds the total.
    if (!isTeam || !(depositAmount > 0) || depositAmount > totalPrice) {
      depositAmount = totalPrice;
    }
    // "Pay the whole fee now" collapses the deposit into the full amount.
    if (paymentMethod === 'venmo' && payInFull) depositAmount = totalPrice;
    const amountDueNow = depositAmount;
    const balanceDue = Math.max(0, totalPrice - amountDueNow);

    // Generate a registration ID
    const regId = crypto.randomBytes(8).toString('hex');

    // Create the registration record (pending until payment confirms)
    const registration = {
      id: regId,
      seasonId: seasonId || null,
      circuit: circuitStored,
      division,
      divisionLabel: divisionLabel || division,
      path,
      status: 'pending',
      paymentMethod,
      price: totalPrice,
      totalPrice: totalPrice,
      paymentType: isTeam && amountDueNow < totalPrice ? 'deposit' : 'full',
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

    const siteUrl = process.env.SITE_URL || `https://${process.env.URL || 'localhost:8888'}`;

    const customerEmail = path === 'team'
      ? team?.players?.[0]?.email
      : agent?.email;

    // ── Venmo ──────────────────────────────────────────────────
    // No Stripe session. The registration stays in pending/ with the exact
    // amount + note we asked them to send; the success page and a follow-up
    // email repeat the instructions. An admin confirms it from the
    // Registrations tab ("Venmo received") once the payment shows up.
    if (paymentMethod === 'venmo') {
      const displayName = isTeam ? (team?.name || 'Team') : (agent?.name || 'Free agent');
      const refCode = regId.slice(-6).toUpperCase();
      registration.venmo = {
        handle: VENMO_HANDLE,
        url: venmoProfileUrl(VENMO_HANDLE),
        amount: amountDueNow,
        note: `Dink Society · ${displayName} · ${refCode}`,
        requestedAt: new Date().toISOString(),
      };
      registration.paymentStatus = 'unpaid';
      await regStore.set(pendingKey, JSON.stringify(registration));

      const contactName = isTeam ? (team?.captain || team?.players?.[0]?.name || '') : (agent?.name || '');
      const dueLabel = fmtDueDate(balanceDueDate);
      if (customerEmail) {
        try {
          await sendEmail({
            to: customerEmail,
            subject: `Almost in — send your $${amountDueNow} Venmo ${balanceDue > 0 ? 'deposit' : 'payment'} (${seasonName})`,
            html: `
              <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
                <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#f5f5f5;margin-bottom:32px;">THE DINK SOCIETY</div>
                <h1 style="font-size:24px;font-weight:800;text-transform:uppercase;color:#f5f5f5;margin:0 0 8px;">Almost in${contactName ? ', ' + contactName.split(' ')[0] : ''}.</h1>
                <p style="font-size:15px;color:#8a8a8a;line-height:1.6;margin:0 0 24px;">
                  We've got <strong style="color:#f5f5f5;">${displayName}</strong> down for <strong style="color:#f5f5f5;">${seasonName}</strong> (${divisionLabel || division}). Your spot is held as soon as your Venmo payment lands.
                </p>
                <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #3d95ce;padding:20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
                  <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#3d95ce;margin-bottom:12px;font-weight:700;">Pay by Venmo${balanceDue > 0 ? ' — deposit' : ' — paid in full'}</div>
                  <table style="width:100%;font-size:14px;color:#f5f5f5;">
                    <tr><td style="padding:6px 0;color:#8a8a8a;">Send to</td><td style="padding:6px 0;text-align:right;font-weight:700;">@${VENMO_HANDLE}</td></tr>
                    <tr><td style="padding:6px 0;color:#8a8a8a;">Amount</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#b8ff2c;">$${amountDueNow}</td></tr>
                    <tr><td style="padding:6px 0;color:#8a8a8a;">Note</td><td style="padding:6px 0;text-align:right;font-weight:600;">${registration.venmo.note}</td></tr>
                  </table>
                  <a href="${registration.venmo.url}" style="display:inline-block;margin-top:14px;padding:12px 28px;background:#3d95ce;color:#fff;font-size:13px;font-weight:700;text-decoration:none;border-radius:9999px;">Open Venmo →</a>
                </div>
                ${balanceDue > 0 ? `
                <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #ffb400;padding:16px 20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
                  <p style="font-size:14px;margin:0;line-height:1.6;color:#8a8a8a;">
                    <strong style="color:#f5f5f5;">Balance:</strong> the remaining $${balanceDue} of the $${totalPrice} team fee is due${dueLabel ? ' by ' + dueLabel : ' one week before the season starts'}.
                  </p>
                </div>` : ''}
                <p style="font-size:14px;color:#8a8a8a;line-height:1.6;margin:0 0 24px;">
                  Once we match your payment (usually the same day) you'll get a confirmation email with your Captain Portal link. Reference: <span style="font-family:monospace;color:#f5f5f5;">${regId.toUpperCase()}</span>
                </p>
                <div style="margin-top:40px;padding-top:20px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">
                  The Dink Society · Southern California Pickleball League
                </div>
              </div>
            `,
          });
        } catch (emailErr) {
          console.error('Venmo instructions email failed:', emailErr);
        }
      }

      // Heads-up to the admin inbox so the deposit can be matched + confirmed.
      const adminTo = process.env.EMAIL_ADMIN_BCC || process.env.EMAIL_REPLY_TO;
      if (adminTo) {
        try {
          await sendEmail({
            to: adminTo,
            subject: `Venmo registration: ${displayName} — expect $${amountDueNow}${balanceDue > 0 ? ' deposit' : ' (full fee)'}`,
            html: `
              <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#0e0e0e;color:#f5f5f5;">
                <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:24px;">THE DINK SOCIETY</div>
                <h1 style="font-size:20px;font-weight:800;margin:0 0 12px;">New Venmo registration</h1>
                <p style="font-size:14px;color:#cfcfcf;line-height:1.6;margin:0 0 16px;"><b style="color:#fff;">${displayName}</b> (${divisionLabel || division}, ${seasonName}) chose Venmo. Look for <b style="color:#fff;">$${amountDueNow}</b> from ${contactName || customerEmail || 'the captain'} with note <b style="color:#fff;">${registration.venmo.note}</b>, then hit <b style="color:#fff;">Venmo received</b> on the Registrations tab.</p>
                <a href="${siteUrl}/admin.html" style="display:inline-block;padding:12px 28px;background:#b8ff2c;color:#0e0e0e;font-size:13px;font-weight:700;text-decoration:none;border-radius:9999px;">Open Admin →</a>
              </div>
            `,
          });
        } catch (emailErr) {
          console.error('Venmo admin notify failed:', emailErr);
        }
      }

      return new Response(JSON.stringify({ confirmationUrl: `${siteUrl}/register-success.html?id=${regId}&pay=venmo`, paymentMethod: 'venmo' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // ───────────────────────────────────────────────────────────

    // Build the Stripe Checkout Session
    const stripe = new Stripe(stripeKey);

    const sessionParams = {
      mode: 'payment',
      success_url: `${siteUrl}/register-success.html?id=${regId}`,
      cancel_url: `${siteUrl}/register.html`,
      customer_email: customerEmail || undefined,
      // Show an "Add promotion code" box on the Stripe checkout page so teams
      // can enter a discount code (e.g. sponsor 50% off). Coupons + promotion
      // codes are created/managed in the Stripe dashboard; Stripe applies the
      // discount and enforces redemption limits.
      allow_promotion_codes: true,
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
            description: `${seasonName} · ${divisionLabel || division} · $${amountDueNow} deposit toward the $${totalPrice} team fee`,
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
            description: `${seasonName} · ${divisionLabel || division}`,
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
