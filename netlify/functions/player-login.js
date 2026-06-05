// netlify/functions/player-login.js
// Email → magic-link for players. Always returns a generic 200 (no enumeration).

import { findPlayerByEmail, createPlayerToken } from './lib/player-auth.js';
import { sendEmail, renderPlayerMagicLink } from './lib/email.js';

const GENERIC = {
  ok: true,
  message: "If that email is on a team roster, we just sent a sign-in link. Check your inbox.",
};

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { email } = await req.json();
    const normalized = (email || '').toString().trim().toLowerCase();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return json({ error: 'Valid email required' }, 400);
    }

    const found = await findPlayerByEmail(normalized);
    if (!found) {
      await new Promise(r => setTimeout(r, 300)); // uniform timing
      return json(GENERIC);
    }

    const token = await createPlayerToken({ email: normalized, playerId: found.playerId, teamId: found.teamId });
    const siteUrl = Netlify.env.get('SITE_URL') || 'https://dinksociety.netlify.app';
    const magicUrl = `${siteUrl}/.netlify/functions/player-link?token=${token}`;

    await sendEmail({
      to: normalized,
      subject: 'Your Dink Society sign-in link',
      html: renderPlayerMagicLink(magicUrl, found.name),
    });

    return json(GENERIC);
  } catch (err) {
    console.error('player-login error:', err);
    return json(GENERIC);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/.netlify/functions/player-login' };
