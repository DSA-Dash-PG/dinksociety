// netlify/functions/admin-payment-config.js
// GET — admin only. Reports whether the payment/email environment variables are
// PRESENT on the server (Netlify), so an admin can verify setup after a redeploy.
// Never returns any secret values — only booleans, the Stripe mode, and short notes.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';

const envGet = (k) => (typeof Netlify !== 'undefined' && Netlify.env && Netlify.env.get(k)) || process.env[k] || '';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const stripeKey = envGet('STRIPE_SECRET_KEY');
  const mode = stripeKey.startsWith('sk_live_') ? 'live' : stripeKey.startsWith('sk_test_') ? 'test' : (stripeKey ? 'unknown' : 'missing');
  const ladderWh = envGet('LADDER_STRIPE_WEBHOOK_SECRET');
  const genericWh = envGet('STRIPE_WEBHOOK_SECRET');
  const resend = envGet('RESEND_API_KEY');
  const from = envGet('EMAIL_FROM');
  const organizers = envGet('LADDER_ORGANIZER_EMAILS');
  const adminBcc = envGet('EMAIL_ADMIN_BCC');
  const replyTo = envGet('EMAIL_REPLY_TO');

  const checks = [
    { key: 'STRIPE_SECRET_KEY', label: 'Stripe secret key', ok: !!stripeKey, note: stripeKey ? mode + ' mode' : 'missing' },
    { key: 'LADDER_STRIPE_WEBHOOK_SECRET', label: 'Ladder webhook signing secret', ok: !!(ladderWh || genericWh), note: ladderWh ? 'set' : genericWh ? 'using STRIPE_WEBHOOK_SECRET fallback' : 'missing' },
    { key: 'RESEND_API_KEY', label: 'Email sending (Resend)', ok: !!resend, note: resend ? 'set' : 'missing — no emails send' },
    { key: 'EMAIL_FROM', label: 'Email “from” address', ok: !!from, note: from ? 'set' : 'missing — emails skipped' },
    { key: 'organizer recipients', label: 'Signup notification recipients', ok: !!(organizers || adminBcc || replyTo), note: organizers ? 'LADDER_ORGANIZER_EMAILS set' : adminBcc ? 'EMAIL_ADMIN_BCC fallback' : replyTo ? 'EMAIL_REPLY_TO fallback' : 'missing — no signup emails' },
  ];
  const ok = checks.every(c => c.ok);
  return json({ ok, mode, checks });
};

export const config = { path: '/.netlify/functions/admin-payment-config' };
