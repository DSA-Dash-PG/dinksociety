// netlify/functions/public-leaderboard.js
//
// PUBLIC endpoint — no auth. Returns pre-computed standings + player-stats
// aggregates for a Circuit. Also returns schedule + recent results for
// context. One blob fetch per aggregate, then the schedule scan for
// recent/upcoming.
//
// GET /.netlify/functions/public-leaderboard?circuit=I[&view=standings|players|schedule]
//   standings (default) → team standings grouped by division + society circuit
//   players             → player stats across the whole Circuit
//   schedule            → all matches chronologically (finalized + upcoming)

import { getStore } from '@netlify/blobs';

const DIVISIONS = ['3.0M', '3.5M', '3.5W'];

export default async (req) => {
  const url = new URL(req.url);
  const circuit = (url.searchParams.get('circuit') || 'I').trim();
  const view = (url.searchParams.get('view') || 'standings').trim();

  try {
    if (view === 'players') {
      return await serveAggregate(circuit, 'player-stats', `player-stats/${circuit}.json`);
    }
    if (view === 'schedule') {
      return await serveSchedule(circuit);
    }
    // Default: standings (includes per-division + society circuit ranking)
    return await serveAggregate(circuit, 'standings', `standings/${circuit}.json`);
  } catch (err) {
    console.error('public-leaderboard error:', err);
    return json({ error: 'Leaderboard unavailable' }, 500);
  }
};

async function serveAggregate(circuit, storeName, key) {
  const store = getStore(storeName);
  const data = await store.get(key, { type: 'json' }).catch(() => null);
  if (!data) {
    return json({
      circuit,
      empty: true,
      message: 'No data yet for this Circuit. Standings populate as matches finalize.',
    });
  }
  return json({ circuit, ...data });
}

async function serveSchedule(circuit) {
  const store = getStore('schedule');
  const { blobs } = await store.list({ prefix: `schedule/${circuit}/` });

  const allMatches = [];
  for (const b of blobs) {
    const data = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    for (const m of data.matches) {
      allMatches.push({
        id: m.id,
        circuit: data.circuit,
        division: data.division,
        week: data.week,
        court: m.court || null,
        venue: m.venue || null,
        scheduledAt: m.scheduledAt || null,
        teamA: { id: m.teamA?.id, name: m.teamA?.name },
        teamB: { id: m.teamB?.id, name: m.teamB?.name },
        scoreA: m.scoreA ?? null,
        scoreB: m.scoreB ?? null,
        finalizedAt: m.finalizedAt || null,
      });
    }
  }

  // Sort: finalized newest-first, then upcoming chronological
  const finalized = allMatches.filter(m => m.finalizedAt)
    .sort((a, b) => new Date(b.finalizedAt) - new Date(a.finalizedAt));
  const upcoming = allMatches.filter(m => !m.finalizedAt)
    .sort((a, b) => (a.week - b.week) || (new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0)));

  return json({ circuit, finalized, upcoming });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30',
    },
  });
}

export const config = { path: '/.netlify/functions/public-leaderboard' };
