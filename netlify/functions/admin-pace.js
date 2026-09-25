// netlify/functions/admin-pace.js
//
// Admin-only "Game Pace" API — how long each game, round and match took,
// per team and per player, built from score-entry times (lib/pace.js).
//
// GET  ?circuit=II&week=2&offset=5
//        circuit  optional — defaults to the live season
//        week     optional — defaults to the latest week with timed games
//        offset   optional — minutes after scheduledAt that play starts (default 5)
//      → { circuit, week, weeks, night, matches, teams, players, fastestGames,
//          slowestGames, season, insights, brief }
//
// POST ?action=backfill
//      body: { matchId, timing: { r1g1: { enteredAt, confirmedAt }, ... }, overwrite: false }
//      Writes game.timing for a match whose captain timestamps were lost
//      (e.g. an admin re-save before this fix). Only fills gaps unless
//      overwrite:true. Marks source:'backfill'.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { liveCircuit } from './lib/current-season.js';
import { circuitCode } from './lib/circuit.js';
import { SLOT_KEYS } from './lib/score-helpers.js';
import { loadPace, paceBrief } from './lib/pace.js';

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const circuit = url.searchParams.get('circuit') ? circuitCode(url.searchParams.get('circuit')) : await liveCircuit();
    const week = url.searchParams.get('week') || null;
    const offRaw = url.searchParams.get('offset');
    const startOffsetMin = offRaw != null && offRaw !== '' && isFinite(Number(offRaw)) ? Math.max(0, Math.min(60, Number(offRaw))) : undefined;
    try {
      const pace = await loadPace(circuit, week, { startOffsetMin });
      return json({ ...pace, brief: pace.empty ? null : paceBrief(pace) });
    } catch (err) {
      console.error('admin-pace failed:', err);
      return json({ error: err.message || 'Failed to compute pace' }, 500);
    }
  }

  if (req.method === 'POST' && url.searchParams.get('action') === 'backfill') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
    const matchId = String(body?.matchId || '');
    const timing = body?.timing || {};
    const overwrite = !!body?.overwrite;
    if (!matchId) return json({ error: 'matchId required' }, 400);
    for (const [slot, t] of Object.entries(timing)) {
      if (!SLOT_KEYS.includes(slot)) return json({ error: `bad slot ${slot}` }, 400);
      for (const k of ['enteredAt', 'confirmedAt']) {
        if (t?.[k] != null && isNaN(new Date(t[k]).getTime())) return json({ error: `${slot}.${k} is not a valid timestamp` }, 400);
      }
    }

    const store = getStore({ name: 'scores', consistency: 'strong' });
    const key = `score/${matchId}.json`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const got = await store.getWithMetadata(key, { type: 'json' }).catch(() => null);
      if (!got?.data) return json({ error: 'No score record for that match' }, 404);
      const rec = got.data;
      let changed = 0;
      for (const [slot, t] of Object.entries(timing)) {
        const g = rec.games?.[slot];
        if (!g) continue;
        g.timing = g.timing || {};
        let slotChanged = false;
        for (const k of ['enteredAt', 'confirmedAt']) {
          if (!t?.[k]) continue;
          if (g.timing[k] && !overwrite) continue;
          g.timing[k] = new Date(t[k]).toISOString();
          slotChanged = true;
          changed++;
        }
        if (slotChanged) g.timing.source = 'backfill';
      }
      if (!changed) return json({ ok: true, changed: 0 });
      rec.timingBackfilledAt = new Date().toISOString();
      rec.timingBackfilledBy = admin.email;
      const res = await store.setJSON(key, rec, { onlyIfMatch: got.etag });
      if (!res || res.modified !== false) return json({ ok: true, changed });
    }
    return json({ error: 'Score record was busy — try again.' }, 503);
  }

  return new Response('Method not allowed', { status: 405 });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-pace' };
