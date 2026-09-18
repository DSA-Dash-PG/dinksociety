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
  // Strong consistency: rebuildStandings writes these aggregates moments before
  // the public read can land. Eventual reads can return the PRE-rebuild blob,
  // which is why a fresh rebuild appeared not to "take". (See June 2026 fix.)
  const store = getStore({ name: storeName, consistency: 'strong' });
  const data = await store.get(key, { type: 'json' }).catch(() => null);
  if (!data) {
    return json({
      circuit,
      empty: true,
      message: 'No data yet for this season. Standings populate as matches finalize.',
    });
  }
  await fillPhotos(data);
  return json({ circuit, ...data });
}

// Profile photos, resolved at read time from the photo store. The standings
// blob only carries a photoUrl for players whose roster entry had a photo stamp
// when it was last rebuilt — anyone who uploaded a photo afterwards showed as
// initials on the home page, leaderboard and cards until the next rebuild.
// One list() over img/ gives every id that has a photo; fill the gaps here.
async function fillPhotos(data) {
  let ids = null;
  const has = async (id) => {
    if (ids === null) {
      ids = new Map();
      try {
        const { blobs } = await getStore('player-photos').list({ prefix: 'img/' });
        for (const b of blobs || []) { const k = b.key.slice(4); if (k) ids.set(k, b.etag || ''); }
      } catch { /* no store yet */ }
    }
    return ids.has(id) ? ids.get(id) : null;
  };
  const url = (id, v) => `/.netlify/functions/player-photo-serve?id=${encodeURIComponent(id)}&v=${encodeURIComponent(v || '')}`;
  const fix = async (e) => {
    if (!e || e.photoUrl || !e.playerId) return;
    const v = await has(e.playerId);
    if (v !== null) e.photoUrl = url(e.playerId, v);
  };
  for (const wk of data.weeklyTopPerformers || []) {
    for (const e of wk.men || []) await fix(e);
    for (const e of wk.women || []) await fix(e);
    if (wk.leaders) for (const g of ['men', 'women']) { const L = wk.leaders[g]; if (L) for (const k of Object.keys(L)) for (const e of L[k] || []) await fix(e); }
  }
  if (data.players && typeof data.players === 'object') for (const e of Object.values(data.players)) await fix(e);
}

async function serveSchedule(circuit) {
  // Strong consistency: captain-score.js / rebuildStandings write finalizedAt +
  // scoreA/scoreB onto these schedule blobs. With eventual reads the public
  // schedule can show finalized weeks as still "upcoming" with null scores,
  // even though standings (which read strong) already reflect them.
  const store = getStore({ name: 'schedule', consistency: 'strong' });
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
