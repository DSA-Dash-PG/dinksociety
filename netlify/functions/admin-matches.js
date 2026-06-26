// netlify/functions/admin-matches.js
// GET  ?circuit=I&division=3.5M                → list all matches for circuit+division
// PATCH ?matchId=<id>                           → update an individual match
//       body: { court?, scheduledAt?, venue? }
// DELETE ?circuit=I&division=3.5M&week=N        → wipe a week's schedule (admin override)

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { resolveBracketDisplay } from './lib/bracket.js';

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);
  const store = getStore('schedule');

  // ========== GET ==========
  if (req.method === 'GET') {
    const circuit = url.searchParams.get('circuit') || 'I';
    const division = url.searchParams.get('division');
    const all = url.searchParams.get('all') === '1' || (!division && url.searchParams.has('all'));

    // ── All-divisions mode: list every schedule blob for this circuit and
    // return every match, regardless of division. This surfaces games that
    // live in a division no longer in the admin dropdown (e.g. auto-generated
    // or leftover test games) so they can be seen and deleted. Each match is
    // stamped with its division and week so the UI can label/filter them.
    if (all || !division) {
      const { blobs } = await store.list({ prefix: `schedule/${circuit}/` });
      const weekMap = {};
      const divisions = new Set();
      for (const b of blobs) {
        const data = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (!data?.matches) continue;
        if (data.circuit && data.circuit !== circuit) continue; // season isolation
        // Derive division/week from the blob (key shape: schedule/<circuit>/<division>/week-<n>.json)
        const parts = b.key.split('/');
        const div = data.division || parts[2] || '';
        const wk = data.week || parseInt((parts[3] || '').replace(/\D+/g, ''), 10) || 1;
        if (div) divisions.add(div);
        if (!weekMap[wk]) weekMap[wk] = { week: wk, circuit, matches: [] };
        for (const m of (data.matches || [])) {
          weekMap[wk].matches.push({ ...m, division: div, week: wk });
        }
      }
      const weeks = Object.values(weekMap).sort((a, b) => a.week - b.week);
      return json({ circuit, all: true, divisions: [...divisions], weeks });
    }

    const weeks = [];
    for (let w = 1; w <= 12; w++) {
      const key = `schedule/${circuit}/${division}/week-${w}.json`;
      const data = await store.get(key, { type: 'json' }).catch(() => null);
      if (!data) continue;
      weeks.push({
        week: w,
        circuit, division,
        phase: data.phase || null,
        matches: (data.matches || []).map(m => ({ ...m, division, week: w })),
        generatedAt: data.generatedAt,
        updatedAt: data.updatedAt,
      });
    }

    // Resolve bracket seed previews (Rivalry/Playoffs/Championship) for display.
    resolveBracketWeeksInPlace(weeks);

    return json({ circuit, division, weeks });
  }

  // ========== POST (add one match to a week) ==========
  if (req.method === 'POST') {
    const circuit = url.searchParams.get('circuit') || 'I';
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
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

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
    const allowedFields = ['court', 'courtA', 'courtB', 'courtSet', 'championship', 'scheduledAt', 'startTime', 'venue', 'notes', 'teamA', 'teamB'];
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
        // Team reassignment (incl. home/away swap): normalize and guard
        // against a team being scheduled to play itself.
        if ('teamA' in updates || 'teamB' in updates) {
          const newA = 'teamA' in updates ? updates.teamA : m.teamA;
          const newB = 'teamB' in updates ? updates.teamB : m.teamB;
          if (!newA?.id || !newB?.id) return json({ error: 'teamA and teamB must each have an id' }, 400);
          if (newA.id === newB.id) return json({ error: 'A team cannot play itself' }, 400);
          if ('teamA' in updates) updates.teamA = { id: newA.id, name: newA.name || '' };
          if ('teamB' in updates) updates.teamB = { id: newB.id, name: newB.name || '' };
        }
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

// Overlay resolved seed previews onto the bracket weeks (Wk6–8). Display-only:
// projected teams + seed labels + lock state for the admin schedule tab. Leaves
// round-robin weeks untouched. Mutates the `weeks` array in place.
function resolveBracketWeeksInPlace(weeks) {
  const real = [], bracket = [], teamMap = new Map();
  for (const wk of weeks) {
    for (const m of wk.matches) {
      if (m.phase) { bracket.push(m); }
      else {
        real.push(m);
        if (m.teamA?.id) teamMap.set(m.teamA.id, { id: m.teamA.id, name: m.teamA.name });
        if (m.teamB?.id) teamMap.set(m.teamB.id, { id: m.teamB.id, name: m.teamB.name });
      }
    }
  }
  if (!bracket.length) return;
  const numTeams = teamMap.size;
  if (numTeams < 2 || numTeams % 2 !== 0) return;

  const resolved = resolveBracketDisplay({
    realMatches: real, bracketMatches: bracket, teamList: [...teamMap.values()], numTeams,
  });
  const byId = new Map(resolved.map(r => [r.id, r]));
  for (const wk of weeks) {
    wk.matches = wk.matches.map(m => {
      const r = byId.get(m.id);
      if (!r) return m;
      if (!wk.phase) wk.phase = r.phase || null;
      // Keep slots as seed placeholders until the phase locks (don't reveal the
      // projected team names in the schedule yet).
      return {
        ...m,
        teamA: r.seedLocked ? (r.teamA || null) : null,
        teamB: r.seedLocked ? (r.teamB || null) : null,
        seedLabelA: r.seedLabelA || null,
        seedLabelB: r.seedLabelB || null,
        seedLocked: !!r.seedLocked,
        phase: r.phase, bracketSlot: r.bracketSlot, bracketGroup: r.bracketGroup,
        gameLabel: r.gameLabel || null, placeLabel: r.placeLabel || null, medal: r.medal || null,
      };
    });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-matches' };
