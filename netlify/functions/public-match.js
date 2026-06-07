// netlify/functions/public-match.js
//
// PUBLIC endpoint — no auth. Returns game-by-game detail for a single
// finalized match, used by the schedule page's "Show game scores" toggle.
//
// GET /.netlify/functions/public-match?season=circuit-i&match=<matchId>
//   → { match: { id, week, courtSet, courtA, courtB, finalizedAt,
//                 home:{id,name}, away:{id,name},
//                 matchPoints:{home,away}, games:[{...}],
//                 round1, round2, totals:{home,away} } }
//
// Game rows include player pairs (names only — no PII) pulled from each
// team's locked lineup. Only confirmed games (both scores entered) appear.

import { getStore } from '@netlify/blobs';
import { normalizeScore } from './lib/score-helpers.js';
import { etagJson } from './lib/http-cache.js';
import { isRevealTime } from './lib/lineup-helpers.js';

// Slot → discipline label. Matches lib ordering: g1 women's, g2 men's, rest mixed.
const SLOT_TYPE = {
  r1g1: 'WD', r1g2: 'MD', r1g3: 'MX', r1g4: 'MX', r1g5: 'MX', r1g6: 'MX',
  r2g1: 'WD', r2g2: 'MD', r2g3: 'MX', r2g4: 'MX', r2g5: 'MX', r2g6: 'MX',
};
const SLOT_KEYS = Object.keys(SLOT_TYPE);

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const seasonId = url.searchParams.get('season') || 'circuit-i';
  const matchId = url.searchParams.get('match') || '';
  if (!matchId) return json({ error: 'match id required' }, 400);

  try {
    const circuitLetter = seasonId.replace('circuit-', '').toUpperCase();
    const schedStore = getStore('schedule');

    // Locate the match across this season's schedule blobs.
    const { blobs } = await schedStore.list({ prefix: `schedule/${circuitLetter}/` });
    let found = null;
    for (const b of blobs) {
      const data = await schedStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!data?.matches) continue;
      if (data.circuit && data.circuit !== circuitLetter) continue;
      const m = data.matches.find(x => x.id === matchId);
      if (m) { found = { ...m, week: data.week || m.week || 1 }; break; }
    }
    if (!found) return json({ error: 'match not found' }, 404);

    const homeId = found.teamA?.id || null;
    const awayId = found.teamB?.id || null;

    // Scores + both lineups (best-effort; lineups may be absent).
    const scoresStore = getStore('scores');
    const lineupStore = getStore('lineups');
    const [score, lineupA, lineupB] = await Promise.all([
      scoresStore.get(`score/${matchId}.json`, { type: 'json' }).catch(() => null),
      homeId ? lineupStore.get(`lineup/${matchId}/${homeId}.json`, { type: 'json' }).catch(() => null) : null,
      awayId ? lineupStore.get(`lineup/${matchId}/${awayId}.json`, { type: 'json' }).catch(() => null) : null,
    ]);

    // Migrate any legacy score shape; reads below use the canonical agreed
    // home/away values (only set once both teams' entries match).
    if (score) normalizeScore(score, !!found.championship);

    // Blind-lineup gate: this endpoint is public, so never expose player
    // pairings before the simultaneous reveal. Names are visible only once
    // the match is finalized, or both lineups are locked AND we're inside
    // the reveal window. Draft/early-locked lineups stay hidden.
    const final = !!(found.finalizedAt || score?.finalizedAt);
    const lineupsVisible = final
      || (!!lineupA?.lockedAt && !!lineupB?.lockedAt && isRevealTime(found.scheduledAt));

    const games = [];
    let totalHome = 0, totalAway = 0;
    const sg = score?.games || {};
    const lgA = lineupsVisible ? (lineupA?.games || {}) : {};
    const lgB = lineupsVisible ? (lineupB?.games || {}) : {};

    for (const slot of SLOT_KEYS) {
      const g = sg[slot];
      const h = g?.home, a = g?.away;
      const hasScore = Number.isInteger(h) && Number.isInteger(a);
      if (hasScore) { totalHome += h; totalAway += a; }
      // Skip rows with no score AND no lineup — nothing to show.
      const hp = [lgA[slot]?.p1Name, lgA[slot]?.p2Name].filter(Boolean);
      const ap = [lgB[slot]?.p1Name, lgB[slot]?.p2Name].filter(Boolean);
      if (!hasScore && !hp.length && !ap.length) continue;

      games.push({
        slot,
        round: slot.startsWith('r1') ? 1 : 2,
        gameNum: Number(slot.slice(-1)),
        type: SLOT_TYPE[slot],
        home: hasScore ? h : null,
        away: hasScore ? a : null,
        homeWin: hasScore ? h > a : null,
        homePlayers: hp,
        awayPlayers: ap,
      });
    }

    return etagJson(req, {
      match: {
        id: found.id,
        week: found.week,
        courtSet: found.courtSet ?? null,
        courtA: found.courtA ?? null,
        courtB: found.courtB ?? null,
        finalizedAt: found.finalizedAt || score?.finalizedAt || null,
        home: { id: homeId, name: found.teamA?.name || 'Home' },
        away: { id: awayId, name: found.teamB?.name || 'Away' },
        matchPoints: { home: found.scoreA ?? null, away: found.scoreB ?? null },
        round1: found.round1 || null,
        round2: found.round2 || null,
        totals: { home: totalHome, away: totalAway },
        games,
      },
    });
  } catch (err) {
    console.error('public-match error:', err);
    return json({ error: 'match detail unavailable' }, 500);
  }
};

// Errors only — success responses go through etagJson (ETag + short CDN cache).
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export const config = { path: '/.netlify/functions/public-match' };
