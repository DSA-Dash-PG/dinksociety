// netlify/functions/admin-score-live.js
// Real-time match-night dashboard for league admin.
//
// GET ?circuit=I&division=3.5M&week=1
//   → Returns all matches for that week with live score + pair status for each.
//   → Designed for polling every 8–10 seconds from the admin dashboard.
//   → Includes sanitized homeLineup/awayLineup games so admin can render live roster.
//
// Dual-entry model: the admin sees BOTH teams' versions of every game
// (homeEntry/awayEntry) plus the canonical agreed score once they match.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import {
  SLOT_KEYS, PAIRS, gameStatus, computeRound, normalizeScore,
} from './lib/score-helpers.js';

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

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

      // Fetch lineup lock status AND score record
      const [homeLineup, awayLineup, scoreRec] = await Promise.all([
        lineupStore.get(`lineup/${matchId}/${homeId}.json`, { type: 'json' }).catch(() => null),
        lineupStore.get(`lineup/${matchId}/${awayId}.json`, { type: 'json' }).catch(() => null),
        scoresStore.get(`score/${matchId}.json`, { type: 'json' }).catch(() => null),
      ]);

      const homeLocked = !!homeLineup?.lockedAt;
      const awayLocked = !!awayLineup?.lockedAt;
      const revealed   = homeLocked && awayLocked;

      // Sanitized lineups for admin roster view (names + game assignments only)
      const homeLineupSanitized = homeLineup
        ? { teamId: homeLineup.teamId, teamName: homeLineup.teamName, games: homeLineup.games, lockedAt: homeLineup.lockedAt }
        : null;
      const awayLineupSanitized = awayLineup
        ? { teamId: awayLineup.teamId, teamName: awayLineup.teamName, games: awayLineup.games, lockedAt: awayLineup.lockedAt }
        : null;

      // Normalize (migrates legacy shapes) then compute per-game status.
      const winBy = m.championship ? 2 : 1;
      if (scoreRec) normalizeScore(scoreRec, !!m.championship);
      const games = scoreRec?.games || {};
      const gameStatuses = SLOT_KEYS.map(slot => {
        const g = games[slot] || {};
        return {
          slot,
          status: gameStatus(g, winBy),
          home: g.home ?? null,                // canonical agreed score
          away: g.away ?? null,
          homeEntry: g.homeEntry ? { home: g.homeEntry.home, away: g.homeEntry.away, by: g.homeEntry.by ?? null, at: g.homeEntry.at ?? null } : null,
          awayEntry: g.awayEntry ? { home: g.awayEntry.home, away: g.awayEntry.away, by: g.awayEntry.by ?? null, at: g.awayEntry.at ?? null } : null,
        };
      });

      const statusBySlot = Object.fromEntries(gameStatuses.map(g => [g.slot, g.status]));
      const pairStatuses = [];
      for (let idx = 0; idx < PAIRS.length; idx++) {
        const pair = PAIRS[idx];
        const slotSts = pair.slots.map(s => statusBySlot[s] || 'empty');
        const allConf = slotSts.every(s => s === 'confirmed');
        const hasMismatch = slotSts.some(s => s === 'mismatch');
        const hasPartial = slotSts.some(s => s === 'partial');
        pairStatuses.push({
          ...pair,
          slotStatuses: slotSts,
          confirmed: allConf,
          hasMismatch,
          locked: false,
          state: allConf ? 'confirmed'
               : hasMismatch ? 'mismatch'
               : hasPartial ? 'active'
               : 'pending',
        });
      }

      const counts = gameStatuses.reduce((acc, g) => {
        acc[g.status] = (acc[g.status] || 0) + 1;
        return acc;
      }, { empty: 0, partial: 0, confirmed: 0, mismatch: 0 });

      const mismatches = gameStatuses.filter(g => g.status === 'mismatch').map(g => ({
        slot: g.slot,
        homeEntry: g.homeEntry ? { home: g.homeEntry.home, away: g.homeEntry.away } : null,
        awayEntry: g.awayEntry ? { home: g.awayEntry.home, away: g.awayEntry.away } : null,
      }));

      // Compute round-level and match-level points (only from confirmed games)
      const statusList = gameStatuses.map(g => ({ slot: g.slot, status: g.status }));
      const r1 = computeRound(games, 1, statusList);
      const r2 = computeRound(games, 2, statusList);
      const matchPoints = { home: r1.homePoints + r2.homePoints, away: r1.awayPoints + r2.awayPoints };

      // Overall match status
      let matchState;
      if (scoreRec?.finalizedAt || m.finalizedAt) matchState = 'final';
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
        courtA: m.courtA ?? null,
        courtB: m.courtB ?? null,
        courtSet: m.courtSet ?? null,
        scheduledAt: m.scheduledAt || null,
        startTime: m.startTime || null,
        championship: !!m.championship,
        home: { id: homeId, name: m.teamA?.name },
        away: { id: awayId, name: m.teamB?.name },
        lineup: {
          homeLocked,
          awayLocked,
          revealed,
          home: homeLineupSanitized,
          away: awayLineupSanitized,
        },
        score: {
          games: gameStatuses,
          gamesConfirmed: counts.confirmed,
          gamesTotal: 12,
          mismatches,
          counts,
          pairStatuses,
          round1: r1,
          round2: r2,
          matchPoints,
          homeSubmitted: !!scoreRec?.homeSubmittedAt,
          homeSubmittedBy: scoreRec?.homeSubmittedBy || null,
          homeSignedName: scoreRec?.homeSignedName || null,
          awaySubmitted: !!scoreRec?.awaySubmittedAt,
          awaySubmittedBy: scoreRec?.awaySubmittedBy || null,
          awaySignedName: scoreRec?.awaySignedName || null,
          finalizedAt: scoreRec?.finalizedAt || m.finalizedAt || null,
        },
        state: matchState,
      });
    }
  }

  return json({ circuit, division, weeks: weekParam ? [parseInt(weekParam,10)] : null, matches: result, fetchedAt: new Date().toISOString() });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-score-live' };
