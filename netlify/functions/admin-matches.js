// netlify/functions/admin-matches.js
// GET  ?circuit=I&division=3.5M                → list all matches for circuit+division
// PATCH ?matchId=<id>                           → update an individual match
//       body: { court?, scheduledAt?, venue? }
// DELETE ?circuit=I&division=3.5M&week=N        → wipe a week's schedule (admin override)

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  const url = new URL(req.url);
  const store = getStore('schedule');

  // ========== GET ==========
  if (req.method === 'GET') {
    const circuit = url.searchParams.get('circuit') || 'I';
    const division = url.searchParams.get('division');
    if (!division) return json({ error: 'division required' }, 400);

    const weeks = [];
    for (let w = 1; w <= 12; w++) {
      const key = `schedule/${circuit}/${division}/week-${w}.json`;
      const data = await store.get(key, { type: 'json' }).catch(() => null);
      if (!data) continue;
      weeks.push({
        week: w,
        circuit, division,
        matches: data.matches || [],
        generatedAt: data.generatedAt,
        updatedAt: data.updatedAt,
      });
    }
    return json({ circuit, division, weeks });
  }

  // ========== POST (add one match to a week) ==========
  if (req.method === 'POST') {
    const circuit = url.searchParams.get('circuit') || 'I';
    const body = await req.json();
    const division = body.division;
    const week = parseInt(body.week, 10);
    const teamA = body.teamA, teamB = body.teamB;
    if (!division || !Number.isInteger(week) || week < 1) {
      return json({ error: 'division and a valid week are required' }, 400);
    }
    if (!teamA?.id || !teamB?.id) return json({ error: 'teamA and teamB are required' }, 400);
    if (teamA.id === teamB.id) return json({ error: 'A team cannot play itself' }, 400);

    const key = `schedule/${circuit}/${division}/week-${week}.json`;
    let data = await store.get(key, { type: 'json' }).catch(() => null);
    if (!data) {
      data = { circuit, division, week, matches: [], generatedAt: new Date().toISOString(), generatedBy: admin.email };
    }

    // Guard against duplicating the same pairing within the same week.
    const dup = (data.matches || []).some(m => {
      const ids = [m.teamA?.id, m.teamB?.id];
      return ids.includes(teamA.id) && ids.includes(teamB.id);
    });
    if (dup) return json({ error: 'These two teams already play each other that week' }, 409);

    const courtA = (body.courtA != null && body.courtA !== '') ? body.courtA : null;
    const courtB = (body.courtB != null && body.courtB !== '') ? body.courtB : null;
    const rnd = Math.random().toString(16).slice(2, 8);
    const match = {
      id: `m_${circuit}_${division.toLowerCase()}_w${week}_${rnd}`,
      teamA: { id: teamA.id, name: teamA.name || '' },
      teamB: { id: teamB.id, name: teamB.name || '' },
      courtSet: null,
      courtA, courtB,
      court: (courtA && courtB) ? `Courts ${courtA} & ${courtB}` : null,
      scheduledAt: body.scheduledAt || null,
      startTime: body.startTime || null,   // optional per-match override; blank = season default
      scoreA: null, scoreB: null, playedAt: null,
    };
    data.matches = [...(data.matches || []), match];
    data.updatedAt = new Date().toISOString();
    data.updatedBy = admin.email;
    await store.setJSON(key, data);
    return json({ ok: true, match });
  }

  // ========== PATCH (update single match) ==========
  if (req.method === 'PATCH') {
    const matchId = url.searchParams.get('matchId');
    if (!matchId) return json({ error: 'matchId required' }, 400);

    const body = await req.json();
    const allowedFields = ['court', 'courtA', 'courtB', 'courtSet', 'championship', 'scheduledAt', 'startTime', 'venue', 'notes'];
    const updates = {};
    for (const f of allowedFields) {
      if (f in body) updates[f] = body[f];
    }
    if (Object.keys(updates).length === 0) {
      return json({ error: 'no updatable fields in body' }, 400);
    }

    // Locate the match across all schedule files
    const { blobs } = await store.list({ prefix: 'schedule/' });
    for (const b of blobs) {
      const data = await store.get(b.key, { type: 'json' });
      if (!data?.matches) continue;
      const m = data.matches.find(x => x.id === matchId);
      if (m) {
        Object.assign(m, updates);
        data.updatedAt = new Date().toISOString();
        data.updatedBy = admin.email;
        await store.setJSON(b.key, data);
        return json({ ok: true, match: m });
      }
    }

    return json({ error: 'match not found' }, 404);
  }

  // ========== DELETE (one match by id, or wipe a week) ==========
  if (req.method === 'DELETE') {
    const matchId = url.searchParams.get('matchId');
    if (matchId) {
      const { blobs } = await store.list({ prefix: 'schedule/' });
      for (const b of blobs) {
        const data = await store.get(b.key, { type: 'json' });
        if (!data?.matches) continue;
        const before = data.matches.length;
        data.matches = data.matches.filter(m => m.id !== matchId);
        if (data.matches.length !== before) {
          data.updatedAt = new Date().toISOString();
          data.updatedBy = admin.email;
          await store.setJSON(b.key, data);
          return json({ ok: true, deleted: matchId });
        }
      }
      return json({ error: 'match not found' }, 404);
    }

    const circuit = url.searchParams.get('circuit') || 'I';
    const division = url.searchParams.get('division');
    const week = parseInt(url.searchParams.get('week'), 10);
    if (!division || !Number.isInteger(week)) {
      return json({ error: 'division and week required' }, 400);
    }
    const key = `schedule/${circuit}/${division}/week-${week}.json`;
    await store.delete(key).catch(() => null);
    return json({ ok: true });
  }

  return new Response('Method not allowed', { status: 405 });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-matches' };
