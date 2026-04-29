// netlify/functions/admin-scores.js
// Admin-only score entry and override.
//
// GET  ?match=<id>                → get current score state for a match
// PUT  ?match=<id>               → enter/update scores (admin acts as both sides)
//      body: { games: { r1g1: { home: 11, away: 7 }, ... } }
// POST ?match=<id>&action=finalize  → force-finalize a match
// POST ?match=<id>&action=reopen    → un-finalize a match so scores can be edited

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import { rebuildStandings } from './lib/standings.js';

const SLOT_KEYS = [
  'r1g1','r1g2','r1g3','r1g4','r1g5','r1g6',
  'r2g1','r2g2','r2g3','r2g4','r2g5','r2g6',
];

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const scheduleStore = getStore('schedule');
  const scoresStore = getStore('scores');

  // Find the match across all schedule files
  const match = await findMatch(scheduleStore, matchId);
  if (!match) return json({ error: 'Match not found' }, 404);

  const scoreKey = `score/${matchId}.json`;

  // ===== GET =====
  if (req.method === 'GET') {
    const score = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);
    return json({ match: matchInfo(match), score: decorate(score) });
  }

  // ===== PUT — enter/update scores =====
  if (req.method === 'PUT') {
    const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);

    const body = await req.json();
    const incoming = body.games || {};
    const now = new Date().toISOString();

    for (const slot of SLOT_KEYS) {
      if (!(slot in incoming)) continue;
      const g = incoming[slot];
      if (!existing.games[slot]) existing.games[slot] = { home: null, away: null };

      const homeVal = toScore(g.home);
      const awayVal = toScore(g.away);
      if (homeVal === 'INVALID' || awayVal === 'INVALID') {
        return json({ error: `${slot}: scores must be integers 0-30` }, 400);
      }

      existing.games[slot].home = homeVal !== null
        ? { entered: homeVal, by: admin.email, at: now }
        : null;
      existing.games[slot].away = awayVal !== null
        ? { entered: awayVal, by: admin.email, at: now }
        : null;
    }

    existing.updatedAt = now;
    existing.updatedBy = admin.email;
    existing.adminEdited = true;

    await scoresStore.setJSON(scoreKey, existing);
    return json({ ok: true, score: decorate(existing) });
  }

  // ===== POST — finalize or reopen =====
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');

    if (action === 'finalize') {
      const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null);
      if (!existing) return json({ error: 'No scores entered yet' }, 400);

      const decorated = decorate(existing);
      if (!decorated.computed.allConfirmed) {
        return json({
          error: `Cannot finalize — ${12 - decorated.computed.counts.confirmed} games still need scores.`,
          unentered: decorated.computed.unentered,
        }, 400);
      }

      const now = new Date().toISOString();
      existing.homeSubmittedAt = existing.homeSubmittedAt || now;
      existing.homeSubmittedBy = existing.homeSubmittedBy || admin.email;
      existing.awaySubmittedAt = existing.awaySubmittedAt || now;
      existing.awaySubmittedBy = existing.awaySubmittedBy || admin.email;
      existing.finalizedAt = now;
      existing.finalizedBy = admin.email;

      await scoresStore.setJSON(scoreKey, existing);

      // Write final scores to schedule
      await writeFinalScoreToSchedule(scheduleStore, match, existing);

      // Rebuild standings
      rebuildStandings(match.circuit).catch(err =>
        console.error('rebuildStandings failed:', err)
      );

      return json({ ok: true, finalized: true, score: decorate(existing) });
    }

    if (action === 'reopen') {
      const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null);
      if (!existing) return json({ error: 'No scores to reopen' }, 400);

      existing.finalizedAt = null;
      existing.finalizedBy = null;
      existing.homeSubmittedAt = null;
      existing.homeSubmittedBy = null;
      existing.awaySubmittedAt = null;
      existing.awaySubmittedBy = null;
      existing.reopenedAt = new Date().toISOString();
      existing.reopenedBy = admin.email;

      await scoresStore.setJSON(scoreKey, existing);

      // Clear final scores from schedule
      await clearFinalScoreFromSchedule(scheduleStore, match);

      // Rebuild standings
      rebuildStandings(match.circuit).catch(err =>
        console.error('rebuildStandings failed after reopen:', err)
      );

      return json({ ok: true, reopened: true, score: decorate(existing) });
    }

    return json({ error: 'action must be finalize or reopen' }, 400);
  }

  return new Response('Method not allowed', { status: 405 });
};

// ===== Helpers =====

async function findMatch(scheduleStore, matchId) {
  const { blobs } = await scheduleStore.list({ prefix: 'schedule/' });
  for (const b of blobs) {
    const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m) {
      return {
        ...m,
        week: data.week,
        circuit: data.circuit,
        division: data.division,
        scheduleKey: b.key,
      };
    }
  }
  return null;
}

function newScoreRecord(match) {
  const games = {};
  for (const slot of SLOT_KEYS) games[slot] = { home: null, away: null };
  return {
    matchId: match.id,
    circuit: match.circuit,
    division: match.division,
    week: match.week,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
    games,
    homeSubmittedAt: null, homeSubmittedBy: null,
    awaySubmittedAt: null, awaySubmittedBy: null,
    finalizedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function matchInfo(match) {
  return {
    id: match.id,
    week: match.week,
    circuit: match.circuit,
    division: match.division,
    court: match.court || null,
    scheduledAt: match.scheduledAt || null,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
    finalizedAt: match.finalizedAt || null,
  };
}

function toScore(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 30) return 'INVALID';
  return n;
}

function gameStatus(game) {
  const h = game?.home;
  const a = game?.away;
  if (!h && !a) return 'empty';
  if (!h || !a) return 'partial';
  if (h.entered === a.entered) return 'confirmed';
  return 'mismatch';
}

function decorate(score) {
  const gameStatuses = SLOT_KEYS.map(slot => ({
    slot,
    status: gameStatus(score.games[slot]),
    home: score.games[slot]?.home?.entered ?? null,
    away: score.games[slot]?.away?.entered ?? null,
  }));

  const counts = gameStatuses.reduce((acc, g) => {
    acc[g.status] = (acc[g.status] || 0) + 1;
    return acc;
  }, { empty: 0, partial: 0, confirmed: 0, mismatch: 0 });

  const r1 = computeRound(score.games, 1, gameStatuses);
  const r2 = computeRound(score.games, 2, gameStatuses);
  const matchHome = r1.homePoints + r2.homePoints;
  const matchAway = r1.awayPoints + r2.awayPoints;

  return {
    ...score,
    computed: {
      gameStatuses,
      counts,
      round1: r1,
      round2: r2,
      matchPoints: { home: matchHome, away: matchAway },
      matchWinner: matchHome > matchAway ? 'home' : matchAway > matchHome ? 'away' : 'tie',
      allConfirmed: counts.confirmed === 12,
      unentered: gameStatuses.filter(g => g.status !== 'confirmed').map(g => g.slot),
    },
  };
}

function computeRound(games, roundNum, gameStatuses) {
  const statusBySlot = Object.fromEntries(gameStatuses.map(g => [g.slot, g.status]));
  let homeGames = 0, awayGames = 0, scored = 0;
  for (let g = 1; g <= 6; g++) {
    const slot = `r${roundNum}g${g}`;
    if (statusBySlot[slot] !== 'confirmed') continue;
    const gs = games[slot];
    scored++;
    if (gs.home.entered > gs.away.entered) homeGames++;
    else if (gs.away.entered > gs.home.entered) awayGames++;
  }
  let homePoints = 0, awayPoints = 0;
  if (scored === 6) {
    if (homeGames > awayGames) homePoints = 2;
    else if (awayGames > homeGames) awayPoints = 2;
    else { homePoints = 1; awayPoints = 1; }
  }
  return { homeGames, awayGames, homePoints, awayPoints, scoredGames: scored };
}

async function writeFinalScoreToSchedule(scheduleStore, match, score) {
  const data = await scheduleStore.get(match.scheduleKey, { type: 'json' }).catch(() => null);
  if (!data?.matches) return;
  const m = data.matches.find(x => x.id === match.id);
  if (!m) return;
  const decorated = decorate(score);
  m.scoreA = decorated.computed.matchPoints.home;
  m.scoreB = decorated.computed.matchPoints.away;
  m.finalizedAt = score.finalizedAt;
  m.round1 = decorated.computed.round1;
  m.round2 = decorated.computed.round2;
  data.updatedAt = new Date().toISOString();
  await scheduleStore.setJSON(match.scheduleKey, data);
}

async function clearFinalScoreFromSchedule(scheduleStore, match) {
  const data = await scheduleStore.get(match.scheduleKey, { type: 'json' }).catch(() => null);
  if (!data?.matches) return;
  const m = data.matches.find(x => x.id === match.id);
  if (!m) return;
  m.scoreA = null;
  m.scoreB = null;
  m.finalizedAt = null;
  m.round1 = null;
  m.round2 = null;
  data.updatedAt = new Date().toISOString();
  await scheduleStore.setJSON(match.scheduleKey, data);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-scores' };
