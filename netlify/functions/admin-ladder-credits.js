// netlify/functions/admin-ladder-credits.js
// Admin credit lookup + manual grant/adjust for LADDER credit. Admin session only.
// Credits live in the ladder-credits store keyed by normalized email (lib/credits.js);
// there was no way to view a player's balance from admin before this.
//
//   GET  ?email=<email>                              → { email, balanceCents, ledger }
//   POST { action:'grant',  email, cents, reason }   → issue credit (earn)
//   POST { action:'adjust', email, cents, reason }   → +/- correction (adjust)

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail } from './lib/identity.js';
import { getCredit, earn, adjust } from './lib/credits.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const email = normalizeEmail(url.searchParams.get('email') || '');
    if (!email) return json({ error: 'A valid email is required.' }, 400);
    const rec = await getCredit(email);
    return json({ email, balanceCents: rec.balanceCents, ledger: rec.ledger, updatedAt: rec.updatedAt });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email || '');
    if (!email) return json({ error: 'A valid email is required.' }, 400);
    const cents = Math.round(Number(body.cents) || 0);
    const reason = String(body.reason || '').trim() || 'Admin credit';

    if (body.action === 'grant') {
      if (cents <= 0) return json({ error: 'Enter a positive dollar amount.' }, 400);
      const rec = await earn(email, cents, reason, { key: `admingrant:${email}:${Date.now()}` });
      return json({ ok: true, email, balanceCents: rec.balanceCents, ledger: rec.ledger });
    }
    if (body.action === 'adjust') {
      if (!cents) return json({ error: 'Enter a non-zero amount.' }, 400);
      const rec = await adjust(email, cents, reason, { key: `adminadjust:${email}:${Date.now()}` });
      return json({ ok: true, email, balanceCents: rec.balanceCents, ledger: rec.ledger });
    }
    return json({ error: 'unknown action' }, 400);
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/admin-ladder-credits' };
