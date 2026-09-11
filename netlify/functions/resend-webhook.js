// netlify/functions/resend-webhook.js
//
// Receives Resend delivery/engagement events and files them against the player
// who was mailed. Point a Resend webhook at:
//
//   https://dinksociety.app/api/resend-webhook
//
// and set RESEND_WEBHOOK_SECRET to the signing secret it gives you (whsec_...).
// Subscribe to: email.delivered, email.opened, email.clicked, email.bounced,
// email.complained. Open and Click tracking also have to be switched on for the
// sending domain in Resend, or opened/clicked events are never generated.
//
// Signature verification is Svix's scheme (Resend uses Svix): HMAC-SHA256 over
// "<svix-id>.<svix-timestamp>.<raw body>" keyed by the base64-decoded secret,
// compared against any of the space-separated "v1,<sig>" values. Unsigned or
// mismatched requests are rejected — this endpoint is public, and without the
// check anyone could post fake engagement.
//
// Always answers 2xx once the payload is verified. A non-2xx makes Svix retry,
// and a retry storm over an event we simply don't recognise is worse than
// dropping it.

import crypto from 'node:crypto';
import { recordEvent, getMessage } from './lib/recap-tracking.js';

const TRACKED = new Set([
  'email.delivered', 'email.opened', 'email.clicked',
  'email.bounced', 'email.complained', 'email.delivery_delayed',
]);
const TOLERANCE_S = 5 * 60;

function secret() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('RESEND_WEBHOOK_SECRET'))
    || process.env.RESEND_WEBHOOK_SECRET || '';
}

function verify(raw, headers) {
  const whsec = secret();
  if (!whsec) return { ok: false, why: 'RESEND_WEBHOOK_SECRET is not set' };

  const id = headers.get('svix-id');
  const ts = headers.get('svix-timestamp');
  const sigHeader = headers.get('svix-signature');
  if (!id || !ts || !sigHeader) return { ok: false, why: 'missing svix headers' };

  // Reject replays of an old, validly-signed request.
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > TOLERANCE_S) return { ok: false, why: 'timestamp outside tolerance' };

  const key = Buffer.from(whsec.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key)
    .update(`${id}.${ts}.${raw}`)
    .digest('base64');
  const expectedBuf = Buffer.from(expected);

  const given = sigHeader.split(' ')
    .map(p => p.split(',')[1])
    .filter(Boolean);

  for (const g of given) {
    const gb = Buffer.from(g);
    if (gb.length === expectedBuf.length && crypto.timingSafeEqual(gb, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, why: 'signature mismatch' };
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();
  const v = verify(raw, req.headers);
  if (!v.ok) {
    console.warn('[resend-webhook] rejected:', v.why);
    return new Response(v.why, { status: 401 });
  }

  let body;
  try { body = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  const type = body?.type;
  const d = body?.data || {};
  const messageId = d.email_id || d.id || null;

  if (!type || !TRACKED.has(type) || !messageId) {
    return new Response('ignored', { status: 200 });
  }

  try {
    // Only file events for mail we actually sent and indexed. Anything else is
    // some other Resend traffic on the same domain.
    const known = await getMessage(messageId);
    if (!known) return new Response('unknown message', { status: 200 });

    await recordEvent({
      messageId,
      type: type.replace(/^email\./, ''),
      at: d.click?.timestamp || d.open?.timestamp || body.created_at || new Date().toISOString(),
      url: d.click?.link || null,
      to: Array.isArray(d.to) ? d.to[0] : (d.to || null),
    });
  } catch (err) {
    // Swallow: a storage hiccup must not trigger an endless Svix retry loop.
    console.error('[resend-webhook] record failed:', err);
  }

  return new Response('ok', { status: 200 });
};

export const config = { path: '/.netlify/functions/resend-webhook' };
