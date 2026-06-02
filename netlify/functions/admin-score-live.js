// netlify/functions/admin-score-live.js
// Real-time match-night dashboard for league admin.
//
// GET ?circuit=I&division=3.5M&week=1
//   → Returns all matches for that week with live score + pair status for each.
//   → Designed for polling every 8–10 seconds from the admin dashboard.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

const PAIRS = [
  { id: 'r1p1', slots: ['r1g1','r1g2'], round: 1, pair: 1, label: 'R1 P1' },
  { id: 'r1p2', slots: ['r1g3','r1g4'], round: 1, pair: 2, label: 'R1 P2' },
  { id: 'r1p3', slots: ['r1g5','r1g6'], round: 1, pair: 3, label: 'R1 P3' },
  { id: 'r2p1', slots: ['r2g1','r2g2'], round: 2, pair: 1, label: 'R2 P1' },
  { id: 'r2p2', slots: ['r2g3','r2g4'], round: 2, pair: 2, label: 'R2 P2' },
  { id: 'r2p3', slots: ['r2g5','r2g6'], round: 2, pair: 3, label: 'R2 P3' },
];

const SLOT_KEYS = [
  'r1g1','r1g2','r1g3','r1g4','r1g5','r1g6',
  'r2g1','r2g2','r2g3','r2g4','r2g5','r2g6',
];

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const circuit  = url.searchParams.get('circuit')  || 'I';
  const division = url.searchParams.get('division');
  const weekParam = url.searchParams.get('week');

  if (!division) return json({ error: 'division required' }, 400);

  const scheduleStore = getStore('schedule');
  const lineupStore   = getStore('lineups');
  const scoresStore   = getStore('scores');

  // Determine which weeks to fetch (single week or all 1–8)
  const weeks = weekParam ? [parseInt(weekParam, 10)] : [1,2,3,4,5,6,7,8];

  const result = [];

  for (const week of weeks) {
    const key = `schedule/${circuit}/${division}/week-${week}.json`;
    const data = await scheduleStore.get(key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;

    for (const m of data.matches) {
      const matchId = m.id;
      const homeId = m.teamA?.id;
      const awayId = m.teamB?.id;

      // Fetch lineup lock status
      const [homeLineup, awayLineup, scoreRec] = await Promise.all([
        lineupStore.get(`lineup/${matchId}/${homeId}.json`, { type: 'json' }).catch(() => null),
        lineupStore.get(`lineup/${matchId}/${awayId}.json`, { type: 'json' }).catch(() => null),
        scoresStore.get(`score/${matchId}.json`, { type: 'json' }).catch(() => null),
      ]);

      const homeLocked = !!homeLineup?.lockedAt;
      const awayLocked = !!awayLineup?.lockedAt;
      const revealed   = homeLocked && awayLocked;

      // Compute per-game and per-pair status from score record
      const games = scoreRec?.games || {};
      const gameStatuses = SLOT_KEYS.map(slot => ({
        slot,
        status: computeGameStatus(games[slot]),
      }));

      const statusBySlot = Object.fromEntries(gameStatuses.map(g => [g.slot, g.status]));
      const pairStatuses = [];
      for (let idx = 0; idx < PAIRS.length; idx++) {
        const pair = PAIRS[idx];
        const slotSts = pair.slots.map(s => statusBySlot[s] || 'empty');
        const allConf = slotSts.every(s => s === 'confirmed');
        const hasMismatch = slotSts.some(s => s === 'mismatch');
        const hasPartial = slotSts.some(s => s === 'partial');
        const prevConfirmed = idx === 0 || pairStatuses[idx - 1].confirmed;
        pairStatuses.push({
          ...pair,
          slotStatuses: slotSts,
          confirmed: allConf,
          hasMismatch,
          locked: !prevConfirmed,
          state: !prevConfirmed ? 'locked'
               : allConf ? 'confirmed'
               : hasMismatch ? 'mismatch'
               : hasPartial ? 'active'
               : 'pending',
        });
      }

      const counts = gameStatuses.reduce((acc, g) => {
        acc[g.status] = (acc[g.status] || 0) + 1;
        return acc;
      }, { empty: 0, partial: 0, confirmed: 0, mismatch: 0 });

      const mismatches = gameStatuses.filter(g => g.status === 'mismatch').map(g => g.slot);

      // Compute round-level and match-level points (only from confirmed games)
      const r1 = computeRound(games, 1, statusBySlot);
      const r2 = computeRound(games, 2, statusBySlot);
      const matchPoints = { home: r1.homePoints + r2.homePoints, away: r1.awayPoints + r2.awayPoints };

      // Overall match status
      let matchState;
      if (scoreRec?.finalizedAt) matchState = 'final';
      else if (mismatches.length > 0) matchState = 'conflict';
      else if (counts.confirmed === 12) matchState = 'ready';
      else if (counts.confirmed > 0 || counts.partial > 0) matchState = 'active';
      else if (revealed) matchState = 'scoring-not-started';
      else if (homeLocked || awayLocked) matchState = 'lineup-pending';
      else matchState = 'lineup-not-started';

      result.push({
        matchId,
        week,
        circuit,
        division,
        court: m.court || null,
        scheduledAt: m.scheduledAt || null,
        home: { id: homeId, name: m.teamA?.name },
        away: { id: awayId, name: m.teamB?.name },
        lineup: { homeLocked, awayLocked, revealed },
        score: {
          gamesConfirmed: counts.confirmed,
          gamesTotal: 12,
          mismatches,
          counts,
          pairStatuses,
          round1: r1,
          round2: r2,
          matchPoints,
          homeSubmitted: !!scoreRec?.homeSubmittedAt,
          awaySubmitted: !!scoreRec?.awaySubmittedAt,
          finalizedAt: scoreRec?.finalizedAt || null,
        },
        state: matchState,
      });
    }
  }

  return json({ circuit, division, weeks: weekParam ? [parseInt(weekParam,10)] : null, matches: result, fetchedAt: new Date().toISOString() });
};

function computeGameStatus(game) {
  if (!game) return 'empty';
  const h = game.home;
  const a = game.away;
  if (!h && !a) return 'empty';
  if (!h || !a) return 'partial';
  if (h.entered === a.entered) return 'confirmed';
  return 'mismatch';
}

function computeRound(games, roundNum, statusBySlot) {
  let homeGames = 0, awayGames = 0, scoredGames = 0;
  let homePts = 0, awayPts = 0;
  for (let g = 1; g <= 6; g++) {
    const slot = `r${roundNum}g${g}`;
    if (statusBySlot[slot] !== 'confirmed') continue;
    const gs = games[slot];
    const h = gs?.home?.entered;
    const a = gs?.away?.entered;
    if (h === undefined || a === undefined) continue;
    scoredGames++;
    if (h > a) homeGames++;
    else if (a > h) awayGames++;
  }
  if (scoredGames === 6) {
    if (homeGames > awayGames) homePts = 2;
    else if (awayGames > homeGames) awayPts = 2;
    else { homePts = 1; awayPts = 1; }
  }
  return { homeGames, awayGames, homePoints: homePts, awayPoints: awayPts, scoredGames };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-score-live' };
