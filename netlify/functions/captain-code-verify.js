// netlify/functions/captain-code-verify.js
// Captain sign-in with the 6-digit code from the sign-in email — the in-app
// alternative to tapping the magic link. POST { email, code } → sets the
// captain session cookie, same as captain-link does after the button.

import { redeemLoginCode } from './lib/login-code.js';
import { consumeMagicToken, createSession, buildCaptainCookie, getTeamById } from './lib/captain-auth.js';
import { allowRequest } from './lib/rate-limit.js';
import { recordLogin } from './lib/activity-log.js';

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Valid email required' }, 400);

  const ip = req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const ok = await allowRequest(`captain-code:ip:${ip}`, { max: 20, windowMin: 15 });
  if (!ok) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);

  const r = await redeemLoginCode({ scope: 'captain', email, code: body.code });
  if (r.error) return json({ error: r.error }, 400);

  const consumed = await consumeMagicToken(r.token);
  if (!consumed) return json({ error: 'That sign-in was already used. Request a new sign-in email.' }, 400);
  const team = await getTeamById(consumed.teamId);
  if (!team) return json({ error: 'That team no longer exists.' }, 400);

  const sessionId = await createSession(team, consumed.email);
  await recordLogin({ email: consumed.email, role: 'captain', team }).catch(() => {});

  return json({ ok: true, redirect: '/captain.html' }, 200, { 'Set-Cookie': buildCaptainCookie(sessionId) });
};

export const config = { path: '/.netlify/functions/captain-code-verify' };
