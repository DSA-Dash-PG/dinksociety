// netlify/functions/stripe-webhook.js
// Receives Stripe webhook events. On `checkout.session.completed`, moves
// the registration from `pending/<id>.json` to `confirmed/<id>.json`
// and updates its status.
//
// Required env vars:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET  — whsec_... from Stripe dashboard when you create the endpoint
//
// Point Stripe at: https://justdinkit.netlify.app/.netlify/functions/stripe-webhook
// Listen for: checkout.session.completed

import { getStore } from '@netlify/blobs';
import Stripe from 'stripe';
import { sendEmail, renderRegistrationConfirmation } from './lib/email.js';

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const stripeKey = Netlify.env.get('STRIPE_SECRET_KEY');
  const webhookSecret = Netlify.env.get('STRIPE_WEBHOOK_SECRET');
  if (!stripeKey || !webhookSecret) {
    console.error('Stripe env vars missing');
    return new Response('Server misconfigured', { status: 500 });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (event.type !== 'checkout.session.completed') {
    return new Response(JSON.stringify({ received: true, skipped: event.type }), { status: 200 });
  }

  const session = event.data.object;
  const registrationId = session.metadata?.registrationId;
  if (!registrationId) {
    console.error('Missing registrationId in session metadata');
    return new Response('OK (no registrationId)', { status: 200 });
  }

  try {
    const store = getStore('registrations');
    const pending = await store.get(`pending/${registrationId}.json`, { type: 'json' });

    if (!pending) {
      console.warn(`No pending registration found for ${registrationId}`);
      return new Response('OK (no pending record)', { status: 200 });
    }

    const confirmed = {
      ...pending,
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent,
      amountPaid: session.amount_total,
      currency: session.currency,
    };

    await store.setJSON(`confirmed/${registrationId}.json`, confirmed);
    await store.delete(`pending/${registrationId}.json`);

    // ===== Send confirmation email =====
    try {
      const recipient = confirmed.path === 'team'
        ? confirmed.team.players[0].email
        : confirmed.agent.email;
      const adminBcc = Netlify.env.get('EMAIL_ADMIN_BCC');

      const emailResult = await sendEmail({
        to: recipient,
        subject: `You're in — Circuit ${confirmed.circuit}, ${confirmed.divisionLabel}`,
        html: renderRegistrationConfirmation(confirmed),
        bcc: adminBcc ? [adminBcc] : undefined,
      });

      if (!emailResult.ok && !emailResult.skipped) {
        console.error('Confirmation email failed:', emailResult.error);
        // Don't fail the webhook — Stripe will retry if we 500, and the
        // registration is already confirmed. Just log it.
      }
    } catch (emailErr) {
      console.error('Email send threw:', emailErr);
    }

    return new Response(JSON.stringify({ received: true, confirmed: registrationId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Confirmation write failed:', err);
    return new Response('Internal error', { status: 500 });
  }
};

export const config = {
  path: '/.netlify/functions/stripe-webhook',
  // Stripe webhooks need the raw body; the default Netlify Functions runtime
  // passes req.text() through unchanged, so we're fine.
};
