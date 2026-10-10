// netlify/functions/admin-night-recap.js
// Admin side of the league "morning-after" email (the Receipt).
//
//   GET                          → { circuit, settings, latestWeek, due, dueReason,
//                                    coveredByAutoSend, weeks:[state…] }
//   GET ?week=N                  → the same plus players:[{ playerId, name,
//                                    teamName, record, hasEmail, sent }]
//   GET ?week=N&player=<id>      → { subject, preheader, html } — that player's
//                                    email exactly as it would send, with the
//                                    in/out buttons made inert
//   POST action=test             → { week, playerId } send that player's version
//                                    to YOUR admin address (subject "[Test] …")
//   POST action=send             → { week } mail the week now to everyone who has
//                                    not had it (also the retry for anyone missed)
//   POST action=settings         → { autoSend } switch the automatic send on/off
//
// Cookie-authed admin only. `circuit` comes from the admin's working season;
// with none given it falls back to the LIVE season, never a hardcoded 'I'.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { liveCircuit } from './lib/current-season.js';
import { circuitCode } from './lib/circuit.js';
import {
  statusFor, listWeekPlayers, previewFor, sendTest,
  queueWeek, kickBackground, setAutoSend,
} from './lib/night-recap.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload || {};

  const url = new URL(req.url);
  const circuit = circuitCode((url.searchParams.get('circuit') || '').trim() || await liveCircuit());

  try {
    if (req.method === 'GET') {
      const week = url.searchParams.get('week');
      const player = url.searchParams.get('player');
      if (week && player) {
        const pv = await previewFor(circuit, Number(week), player);
        return json(pv, pv.ok ? 200 : 404);
      }
      const status = await statusFor(circuit);
      if (week) {
        const list = await listWeekPlayers(circuit, Number(week));
        return json({ ...status, week: Number(week), players: list.players, playersReason: list.ok ? null : list.reason });
      }
      return json(status);
    }

    if (req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      const week = Number(body.week);

      if (body.action === 'settings') {
        const settings = await setAutoSend(!!body.autoSend, admin.email || null);
        return json({ ok: true, settings });
      }
      if (!Number.isInteger(week) || week < 1) return json({ error: 'week required' }, 400);

      if (body.action === 'test') {
        if (!body.playerId) return json({ error: 'playerId required' }, 400);
        const out = await sendTest(circuit, week, String(body.playerId), admin.email);
        return json(out, out.ok ? 200 : 400);
      }
      if (body.action === 'send') {
        // force: a week already marked sent can be run again — the per-person
        // ledger means only people who have not had it are mailed.
        const q = await queueWeek(circuit, week, { by: admin.email || 'admin', force: true });
        if (!q.ok) return json({ ok: false, reason: q.reason }, 409);
        const kicked = await kickBackground({ ...q, cookie: req.headers.get('cookie') || '' });
        return json({ ok: kicked, queued: kicked, week, reason: kicked ? null : 'background sender did not accept the job' }, kicked ? 200 : 502);
      }
      return json({ error: 'Unknown action' }, 400);
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('admin-night-recap error:', e);
    return json({ error: String(e?.message || e) }, 500);
  }
};
export const config = { path: '/.netlify/functions/admin-night-recap' };
