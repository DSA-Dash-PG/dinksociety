// netlify/functions/player-code-verify.js
// Sign in with the 6-digit code from the sign-in email (the in-app alternative
// to tapping the magic link). POST { email, code } → sets the player session
// cookie, same as player-link does after the button.

import { redeemLoginCode } from './lib/login-code.js';
import { consumePlayerToken, createPlayerSession, buildPlayerCookie } from './lib/player-auth.js';
import { allowRequest } from './lib/rate-limit.js';
import { getStore } from '@netlify/blobs';
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
  const ok = await allowRequest(`player-code:ip:${ip}`, { max: 20, windowMin: 15 });
  if (!ok) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);

  const r = await redeemLoginCode({ scope: 'player', email, code: body.code });
  if (r.error) return json({ error: r.error }, 400);

  const consumed = await consumePlayerToken(r.token);
  if (!consumed) return json({ error: 'That sign-in was already used. Request a new sign-in email.' }, 400);

  const sessionId = await createPlayerSession({ playerId: consumed.playerId, teamId: consumed.teamId, email: consumed.email });
  const team = consumed.teamId ? await getStore('teams').get(`team/${consumed.teamId}.json`, { type: 'json' }).catch(() => null) : null;
  const rosterEntry = (team?.roster || []).find(p => p.id === consumed.playerId);
  await recordLogin({ email: consumed.email, role: 'player', name: rosterEntry?.name || null, team, playerId: consumed.playerId }).catch(() => {});

  return json({ ok: true, redirect: '/me.html' }, 200, { 'Set-Cookie': buildPlayerCookie(sessionId) });
};

export const config = { path: '/.netlify/functions/player-code-verify' };
