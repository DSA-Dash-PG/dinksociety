// netlify/functions/captain-login.js
// Accepts an email, creates a magic-link token, emails the captain a
// one-tap sign-in URL. ALWAYS returns 200 with a generic success message
// regardless of whether the email is a captain — prevents enumeration.

import { createMagicToken, findTeamByLeaderEmail } from './lib/captain-auth.js';
import { sendEmail, renderCaptainMagicLink } from './lib/email.js';
import { issueLoginCode } from './lib/login-code.js';

const GENERIC_RESPONSE = {
  ok: true,
  message: "If that email is registered as a captain, we just sent a sign-in link. Check your inbox.",
};

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { email } = await req.json();
    const normalized = (email || '').toString().trim().toLowerCase();
    if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      return json({ error: 'Valid email required' }, 400);
    }

    // Always succeed externally. Only send the email if it's a real team
    // leader — the captain (team.captainEmail / isCaptain) OR a co-captain
    // (isCoCaptain on the roster). This used to check captainEmail only, which
    // silently sent nothing to co-captains (Bonkerz, 2026-09-24).
    const match = await findTeamByLeaderEmail(normalized);
    const team = match?.team || null;
    if (!team) {
      // Artificial delay to make response time uniform
      await new Promise(r => setTimeout(r, 300));
      return json(GENERIC_RESPONSE);
    }

    const token = await createMagicToken(normalized, team.id);
    const siteUrl = Netlify.env.get('SITE_URL') || 'https://dinksociety.netlify.app';
    const magicUrl = `${siteUrl}/.netlify/functions/captain-link?token=${token}`;

    // Same token, two doors: the link, or a 6-digit code typed into the app.
    const code = await issueLoginCode({ scope: 'captain', email: normalized, token }).catch(() => null);
    await sendEmail({
      to: normalized,
      subject: code ? `${code} is your captain sign-in code — ${team.name}` : `Sign in to ${team.name} — The Dink Society`,
      html: renderCaptainMagicLink(magicUrl, team.name, code),
    });

    return json(GENERIC_RESPONSE);
  } catch (err) {
    console.error('captain-login error:', err);
    // Still return generic success — don't leak errors that could hint at
    // which addresses trigger paths
    return json(GENERIC_RESPONSE);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/.netlify/functions/captain-login' };
