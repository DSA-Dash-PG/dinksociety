// netlify/functions/night-recap-send-background.js
//
// Sends one week of the league "morning-after" email — in the BACKGROUND.
// Netlify answers 202 at once and lets this run for up to 15 minutes; one email
// per player, paced under Resend's rate limit, is far past the 10–30 seconds an
// ordinary or scheduled function gets.
//
// Two callers, two ways in:
//   • night-recap-cron  — no admin cookie, so it pins a one-time kick token on
//     the week's state record (lib/night-recap.js queueWeek) and sends the same
//     value in `x-night-recap-kick`. Good for that one week, cleared the moment
//     sending starts.
//   • admin-night-recap — the admin's session cookie ("Send now").
//
// POST body: { circuit, week }

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { getState, kickMatches, sendWeek } from './lib/night-recap.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const week = Number(body.week);
  if (!body.circuit || !Number.isInteger(week) || week < 1) return json({ error: 'circuit and week required' }, 400);
  const code = circuitCode(body.circuit);

  const verified = await verifyAdminSession(req);
  const state = await getState(code, week);
  const kick = req.headers.get('x-night-recap-kick') || '';
  if (!verified.valid && !kickMatches(kick, state?.kickToken)) return unauthResponse('Unauthorized');

  // Only a week that was explicitly queued is sent — never one that is already
  // done or already in flight.
  if (!state || state.status !== 'queued') {
    return json({ ok: true, skipped: true, status: state?.status || 'not queued' });
  }

  try {
    const out = await sendWeek(code, week, { by: verified.valid ? (verified.payload?.email || 'admin') : 'cron' });
    return json(out);
  } catch (e) {
    console.error('[night-recap-send-background] failed:', e);
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};
