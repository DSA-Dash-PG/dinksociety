// netlify/functions/player-register.js
// Self-serve account creation for LADDER-ONLY players (no team). Mirrors
// player-login, but for a brand-new email it first creates a "lite" account so
// people who aren't on any league team can still sign in and join ladders.
//
// POST { name, email, gender? }
//   - email already a league player OR an existing lite account → just send the
//     usual magic link (no duplicate account).
//   - brand-new email → create a lite account, then send the magic link.
// Always returns a generic 200 (no account enumeration).

import { findPlayerByEmail, createPlayerToken } from './lib/player-auth.js';
import { createLitePlayer } from './lib/ladder-players.js';
import { sendEmail, renderPlayerMagicLink } from './lib/email.js';
import { allowRequest } from './lib/rate-limit.js';
import { normalizeEmail } from './lib/identity.js';

const GENERIC = {
  ok: true,
  message: "You're all set — we just sent a one-tap sign-in link. Check your inbox.",
};

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const body = await req.json().catch(() => ({}));
    const normalized = normalizeEmail(body.email);
    const name = String(body.name || '').trim().slice(0, 80);
    const gender = ['M', 'F'].includes(body.gender) ? body.gender : null;
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return json({ error: 'Valid email required' }, 400);
    }
    if (!name) return json({ error: 'Name required' }, 400);

    // Rate limit: max 3 per email + 10 per IP / 15 min. Over limit → still
    // GENERIC 200 (no enumeration), we just quietly don't create/send.
    const ip = req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const [emailOk, ipOk] = await Promise.all([
      allowRequest(`player-register:email:${normalized}`, { max: 3, windowMin: 15 }),
      allowRequest(`player-register:ip:${ip}`, { max: 10, windowMin: 15 }),
    ]);
    if (!emailOk || !ipOk) {
      await new Promise(r => setTimeout(r, 300));
      return json(GENERIC);
    }

    // Already known (team player or existing lite account)? Don't make a second
    // account — just resolve them and send a normal magic link.
    let found = await findPlayerByEmail(normalized);
    if (!found) {
      const { record } = await createLitePlayer({ name, email: normalized, gender });
      found = { playerId: record.playerId, teamId: null, name: record.name };
    }

    const { token, code } = await createPlayerToken({ email: normalized, playerId: found.playerId, teamId: found.teamId || null });
    const siteUrl = Netlify.env.get('SITE_URL') || 'https://dinksociety.netlify.app';
    const magicUrl = `${siteUrl}/.netlify/functions/player-link?token=${token}`;

    await sendEmail({
      to: normalized,
      subject: 'Your Dink Society sign-in link',
      html: renderPlayerMagicLink(magicUrl, found.name || name, code),
    });

    return json(GENERIC);
  } catch (err) {
    console.error('player-register error:', err);
    return json(GENERIC);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/.netlify/functions/player-register' };
