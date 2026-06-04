// =============================================================
// POST /api/stripe-webhook  (handles registration + balance payments)
//
// Handles Stripe webhook events. Primary event:
//   checkout.session.completed → marks registration as confirmed
//                                and sends confirmation email.
//
// KEY FORMAT: pending/{id}.json → confirmed/{id}.json
//   On payment success, the blob is moved from the pending/ prefix
//   to confirmed/ so admin-registrations and admin-overview can find it.
//
// Requires env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
// =============================================================

import Stripe from 'stripe';
import { getStore } from '@netlify/blobs';
import { sendEmail } from './lib/email.js';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    console.error('Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
    return new Response('Server misconfigured', { status: 500 });
  }

  const stripe = new Stripe(stripeKey);

  // Verify the webhook signature
  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // Handle the event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const regId = session.metadata?.registrationId;

    if (!regId) {
      console.warn('checkout.session.completed without registrationId in metadata');
      return new Response('OK', { status: 200 });
    }

    try {
      const regStore = getStore('registrations');

      // ── Balance payment (initiated from the captain portal) ──────
      // The registration already exists and is confirmed; just record the
      // additional payment against it. No pending→confirmed move, and no
      // duplicate confirmation email.
      if (session.metadata?.paymentType === 'balance') {
        const keys = [`confirmed/${regId}.json`, `pending/${regId}.json`, regId];
        let raw = null;
        let foundKey = null;
        for (const k of keys) {
          raw = await regStore.get(k);
          if (raw) { foundKey = k; break; }
        }
        if (!raw) {
          console.warn(`Balance payment for unknown registration ${regId}`);
          return new Response('OK', { status: 200 });
        }
        const reg = JSON.parse(raw);
        const paid = session.amount_total ? session.amount_total / 100 : 0;
        const discount = (session.total_details?.amount_discount || 0) / 100;
        reg.amountPaid = Number(reg.amountPaid || 0) + paid;
        const totalFee = Number(reg.totalPrice || reg.price || reg.amountPaid);
        // A discount on the balance settles the remainder in full.
        reg.balanceDue = discount > 0 ? 0 : Math.max(0, totalFee - reg.amountPaid);
        reg.paymentStatus = reg.balanceDue > 0 ? 'partial' : 'paid_in_full';
        reg.lastPaymentAt = new Date().toISOString();
        reg.balancePaidVia = 'stripe_captain_portal';
        await regStore.set(foundKey, JSON.stringify(reg));
        console.log(`Balance payment recorded for ${regId}: +$${paid}, balanceDue now $${reg.balanceDue}`);
        return new Response('OK', { status: 200 });
      }
      // ─────────────────────────────────────────────────────────────

      // Look for the registration — try prefixed key first, then bare key (legacy)
      const pendingKey = `pending/${regId}.json`;
      const confirmedKey = `confirmed/${regId}.json`;

      let raw = await regStore.get(pendingKey);
      let foundKey = pendingKey;

      if (!raw) {
        // Fallback: try bare key (registrations created before the prefix fix)
        raw = await regStore.get(regId);
        foundKey = regId;
      }

      if (!raw) {
        console.warn(`Registration ${regId} not found in store (tried ${pendingKey} and bare ${regId})`);
        return new Response('OK', { status: 200 });
      }

      const reg = JSON.parse(raw);

      // Mark as confirmed
      reg.status = 'confirmed';
      reg.confirmedAt = new Date().toISOString();
      reg.stripePaymentIntent = session.payment_intent || null;
      reg.stripeCustomer = session.customer || null;

      // Record what was actually collected. For deposit registrations this
      // is the deposit; the rest stays tracked as an outstanding balance.
      const paidNow = session.amount_total
        ? session.amount_total / 100
        : (reg.depositAmount || reg.price || 0);
      const totalFee = reg.totalPrice || reg.price || paidNow;

      // Did the team apply a promotion code at checkout? If so, the discounted
      // amount IS their full obligation — they owe nothing further. Record the
      // discount so it's visible on the registration.
      const discountApplied = (session.total_details?.amount_discount || 0) / 100;
      reg.discountApplied = discountApplied;
      if (discountApplied > 0 && Array.isArray(session.discounts) && session.discounts[0]?.promotion_code) {
        reg.promotionCode = session.discounts[0].promotion_code;
      }

      reg.amountPaid = paidNow;
      reg.depositPaid = paidNow;
      // A discounted checkout settles the account in full (no phantom balance).
      // Otherwise, deposit registrations keep the remainder as an open balance.
      reg.balanceDue = (reg.paymentType === 'deposit' && discountApplied === 0)
        ? Math.max(0, totalFee - paidNow)
        : 0;
      reg.paymentStatus = reg.balanceDue > 0 ? 'deposit_paid' : 'paid_in_full';

      // Write to confirmed/ prefix
      await regStore.set(confirmedKey, JSON.stringify(reg));

      // Delete the old key (pending/ or bare) so there's no duplicate
      if (foundKey !== confirmedKey) {
        try {
          await regStore.delete(foundKey);
        } catch (delErr) {
          console.warn(`Could not delete old key ${foundKey}:`, delErr.message);
        }
      }

      console.log(`Registration ${regId} confirmed via Stripe (moved ${foundKey} → ${confirmedKey})`);

      // ── Create team in the teams store (so captain magic-link login works) ──
      if (reg.path === 'team' && reg.team?.name) {
        try {
          const teamsStore = getStore('teams');
          const teamId = `team_${regId}`;
          const captainEmail = (reg.team.players?.[0]?.email || '').toLowerCase().trim();

          const teamRecord = {
            id: teamId,
            name: reg.team.name,
            captainName: reg.team.captain || null,
            captainEmail: captainEmail || null,
            division: reg.division || null,
            divisionLabel: reg.divisionLabel || null,
            circuit: reg.circuit || 'I',
            roster: (reg.team.players || []).map((p, i) => ({
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
          };

          await teamsStore.setJSON(`team/${teamId}.json`, teamRecord);
          console.log(`Team created: ${teamId} (${reg.team.name}) captain=${captainEmail}`);
        } catch (teamErr) {
          console.error('Failed to create team record:', teamErr);
        }
      }

      // Send confirmation email — Night-Match design system
      const recipientEmail = reg.path === 'team'
        ? reg.team?.players?.[0]?.email
        : reg.agent?.email;

      const recipientName = reg.path === 'team'
        ? reg.team?.captain
        : reg.agent?.name;

      if (recipientEmail) {
        const siteUrl = process.env.SITE_URL || '';
        const isTeam = reg.path === 'team';

        const hasBalance = reg.paymentType === 'deposit' && (reg.balanceDue || 0) > 0;
        const dueDateLabel = (() => {
          if (!reg.balanceDueDate) return '';
          const d = new Date(reg.balanceDueDate + 'T00:00:00');
          return isNaN(d.getTime())
            ? reg.balanceDueDate
            : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        })();
        const paymentRows = hasBalance
          ? `<tr><td style="padding: 6px 0; color: #8a8a8a;">Team fee</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">$${totalFee}</td></tr>
                    <tr><td style="padding: 6px 0; color: #8a8a8a;">Deposit paid</td><td style="padding: 6px 0; text-align: right; font-weight: 600; color: #b8ff2c;">$${reg.depositPaid || reg.amountPaid}</td></tr>
                    <tr><td style="padding: 6px 0; color: #8a8a8a;">Balance due${dueDateLabel ? ' by ' + dueDateLabel : ''}</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">$${reg.balanceDue}</td></tr>`
          : `<tr><td style="padding: 6px 0; color: #8a8a8a;">Amount paid</td><td style="padding: 6px 0; text-align: right; font-weight: 600; color: #b8ff2c;">$${reg.amountPaid || reg.price}</td></tr>`;

        try {
          await sendEmail({
            to: recipientEmail,
            subject: `You're in — ${reg.circuit || 'Dink Society'} registration confirmed`,
            html: `
              <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 40px 20px; background: #0e0e0e; color: #f5f5f5;">
                <div style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; color: #f5f5f5; margin-bottom: 32px;">THE DINK SOCIETY</div>
                <h1 style="font-size: 24px; font-weight: 800; text-transform: uppercase; color: #f5f5f5; margin: 0 0 8px;">You're in${recipientName ? ', ' + recipientName.split(' ')[0] : ''}.</h1>
                <p style="font-size: 15px; color: #8a8a8a; line-height: 1.6; margin: 0 0 24px;">
                  Your registration for <strong style="color: #f5f5f5;">${reg.circuit || 'the league'}</strong> (${reg.divisionLabel || reg.division}) is confirmed.
                </p>

                <div style="background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 20px; margin-bottom: 24px;">
                  <div style="font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: #b8ff2c; margin-bottom: 12px; font-weight: 700;">Your membership</div>
                  <table style="width: 100%; font-size: 14px; color: #f5f5f5;">
                    <tr><td style="padding: 6px 0; color: #8a8a8a;">Season</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${reg.circuit || '—'}</td></tr>
                    <tr><td style="padding: 6px 0; color: #8a8a8a;">Division</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${reg.divisionLabel || reg.division}</td></tr>
                    ${isTeam ? `<tr><td style="padding: 6px 0; color: #8a8a8a;">Team</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${reg.team?.name || '—'}</td></tr>` : ''}
                    <tr><td style="padding: 6px 0; color: #8a8a8a;">Type</td><td style="padding: 6px 0; text-align: right; font-weight: 600;">${isTeam ? 'Team' : 'Free Agent'}</td></tr>
                    ${paymentRows}
                    <tr><td style="padding: 6px 0; color: #8a8a8a;">Reference</td><td style="padding: 6px 0; text-align: right; font-family: monospace; font-size: 12px; color: #8a8a8a;">${regId.toUpperCase()}</td></tr>
                  </table>
                </div>

                ${hasBalance ? `
                <div style="background: #1a1a1a; border: 1px solid #2a2a2a; border-left: 3px solid #b8ff2c; padding: 16px 20px; border-radius: 0 12px 12px 0; margin-bottom: 24px;">
                  <p style="font-size: 14px; margin: 0; line-height: 1.6; color: #8a8a8a;">
                    <strong style="color: #f5f5f5;">Balance reminder:</strong> Your $${reg.balanceDue} team-fee balance is due${dueDateLabel ? ' by ' + dueDateLabel : ' before the season starts'}. We'll follow up with payment details — your spot is held in the meantime.
                  </p>
                </div>
                ` : ''}

                ${isTeam ? `
                <div style="background: #1a1a1a; border: 1px solid #2a2a2a; border-left: 3px solid #b8ff2c; padding: 20px; border-radius: 0 12px 12px 0; margin-bottom: 24px;">
                  <p style="font-size: 14px; margin: 0 0 12px; line-height: 1.6; color: #8a8a8a;">
                    <strong style="color: #f5f5f5;">Next step:</strong> Complete your roster (4–10 players) through the captain portal. You'll receive a separate magic link email for captain access, or request one at:
                  </p>
                  <a href="${siteUrl}/captain.html" style="color: #b8ff2c; font-weight: 600; text-decoration: none;">${siteUrl}/captain.html</a>
                </div>
                ` : `
                <p style="font-size: 14px; color: #8a8a8a; line-height: 1.6; margin: 0 0 24px;">
                  <strong style="color: #f5f5f5;">What's next:</strong> You'll be drafted onto a team before the season starts. Keep an eye on your inbox — your captain will reach out once teams are set.
                </p>
                `}

                <p style="font-size: 12px; color: #555; line-height: 1.5;">
                  Questions? Reply to this email or visit <a href="${siteUrl}/contact.html" style="color: #17d7b0; text-decoration: none;">our contact page</a>.
                </p>
                <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #2a2a2a; font-size: 11px; color: #555;">
                  The Dink Society · Southern California Pickleball League
                </div>
              </div>
            `,
          });
        } catch (emailErr) {
          console.error('Confirmation email failed:', emailErr);
        }
      }
    } catch (err) {
      console.error('Error processing checkout.session.completed:', err);
    }
  }

  // Always return 200 to acknowledge receipt of the webhook event
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
