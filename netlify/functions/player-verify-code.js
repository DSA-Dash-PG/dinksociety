// netlify/functions/player-verify-code.js
// Sign a player in with the 6-digit code from their magic-link email.
//
// This exists for home-screen PWA users: an emailed magic link opens the system
// browser, whose cookie jar is separate from the installed app, so the session
// never reaches the app. Typing the code here runs the sign-in from inside the
// app, so the session cookie lands in the right place.
//
// POST { email, code } → 200 + Set-Cookie (ds_player_session) on success.

import { verifyPlayerCode, createPlayerSession, buildPlayerCookie } from './lib/player-auth.js';
import { allowRequest } from './lib/rate-limit.js';
import { recordLogin } from './lib/activity-log.js';
import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { email, code } = await req.json();
    const normalized = (email || '').toString().trim().toLowerCase();
    const c = (code || '').toString().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || !/^\d{6}$/.test(c)) {
      return json({ error: 'Enter your email and the 6-digit code from your email.' }, 400);
    }

    // Throttle guesses: a 6-digit code is brute-forceable without a cap.
    const ip = req.headers.get('x-nf-client-connection-ip') || 'unknown';
    const [emailOk, ipOk] = await Promise.all([
      allowRequest(`player-code:email:${normalized}`, { max: 6, windowMin: 15 }),
      allowRequest(`player-code:ip:${ip}`, { max: 30, windowMin: 15 }),
    ]);
    if (!emailOk || !ipOk) {
      await new Promise(r => setTimeout(r, 400));
      return json({ error: 'Too many attempts. Wait a few minutes, then request a new link.' }, 429);
    }

    const consumed = await verifyPlayerCode(normalized, c);
    if (!consumed) {
      await new Promise(r => setTimeout(r, 300)); // uniform timing
      return json({ error: 'That code is invalid or has expired. Request a new link and try again.' }, 400);
    }

    const sessionId = await createPlayerSession({
      playerId: consumed.playerId, teamId: consumed.teamId, email: consumed.email,
    });

    // Activity log (never throws, test teams skipped). Lite accounts have no team.
    const team = consumed.teamId
      ? await getStore('teams').get(`team/${consumed.teamId}.json`, { type: 'json' }).catch(() => null)
      : null;
    const rosterEntry = (team?.roster || []).find(p => p.id === consumed.playerId);
    await recordLogin({ email: consumed.email, role: 'player', name: rosterEntry?.name || null, team, playerId: consumed.playerId });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': buildPlayerCookie(sessionId) },
    });
  } catch (err) {
    console.error('player-verify-code error:', err);
    return json({ error: 'Sign-in failed. Please try again.' }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const config = { path: '/.netlify/functions/player-verify-code' };
