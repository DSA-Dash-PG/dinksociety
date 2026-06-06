// =============================================================
// POST /api/admin-unlock-lineups?matchId=<id>
//
// Reopens a match's lineups for BOTH teams (fairness): clears the lock on
// each team's lineup so both captains can edit again, hides the lineups from
// each other once more (reveal needs both locked), and clears any entered
// scores + the finalized result on the schedule so the match is fully reopened.
//
// Both captains then re-lock; the lineups reveal simultaneously again.
//
// Admin-only.
// =============================================================

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);
  const matchId = url.searchParams.get('matchId');
  if (!matchId) return json({ error: 'matchId required' }, 400);

  try {
    const lineupStore = getStore('lineups');
    const scoresStore = getStore('scores');
    const scheduleStore = getStore('schedule');

    const now = new Date().toISOString();
    const result = { matchId, lineupsUnlocked: 0, scoreCleared: false, matchReopened: false };

    // 1) Unlock BOTH teams' lineups (clear lockedAt → editable + hidden again)
    const { blobs: lineupBlobs } = await lineupStore.list({ prefix: `lineup/${matchId}/` });
    for (const b of lineupBlobs) {
      const lu = await lineupStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!lu) continue;
      lu.lockedAt = null;
      lu.lockedBy = null;
      lu.unlockedAt = now;
      lu.unlockedBy = admin.email;
      lu.updatedAt = now;
      await lineupStore.setJSON(b.key, lu);
      result.lineupsUnlocked++;
    }

    // 2) Clear entered scores for this match (changing who played invalidates them)
    const existedScore = await scoresStore.get(`score/${matchId}.json`).catch(() => null);
    if (existedScore) {
      await scoresStore.delete(`score/${matchId}.json`).catch(() => null);
      result.scoreCleared = true;
    }

    // 3) Reopen the schedule match: clear finalized result fields
    let circuit = null;
    const { blobs: schedBlobs } = await scheduleStore.list({ prefix: 'schedule/' });
    for (const b of schedBlobs) {
      const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!data?.matches) continue;
      const m = data.matches.find(x => x.id === matchId);
      if (!m) continue;
      circuit = data.circuit || circuit;
      m.scoreA = null;
      m.scoreB = null;
      m.round1 = null;
      m.round2 = null;
      m.finalizedAt = null;
      m.playedAt = null;
      data.updatedAt = now;
      data.updatedBy = admin.email;
      await scheduleStore.setJSON(b.key, data);
      result.matchReopened = true;
      break;
    }

    // 4) Rebuild standings so the reopened match drops out of the table
    if (circuit) {
      await rebuildStandings(circuit).catch(err =>
        console.error('rebuildStandings after unlock failed:', err)
      );
    }

    return json({ ok: true, ...result });
  } catch (err) {
    console.error('admin-unlock-lineups error:', err);
    return json({ error: 'Unlock failed', detail: err.message }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-unlock-lineups' };
