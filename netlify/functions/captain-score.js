// netlify/functions/captain-score.js
//
// Single-entry scoring with final dual-approval. One shared scoresheet:
// either captain enters each game's home + away score once. The match
// finalizes only when:
//   1. All 12 games have a complete, valid score (to 11, win by 2)
//   2. Both captains have tapped "Submit final" since the last edit
//
// GET   ?match=<id>                          → state + computed view
// PUT   ?match=<id>                          → save game scores (either captain)
//                                                body: { games: { r1g1: { home: 11, away: 4 }, ... } }
// POST  ?match=<id>&action=submit            → mark this captain's "I approve" flag
// POST  ?match=<id>&action=withdraw          → revoke my approval (only allowed pre-finalize)
//
// Storage shape:
//   game = { home: <homeScore>|null, away: <awayScore>|null, by, at }
//
// Computed status per game (server-derived, never persisted):
//   'empty'      both scores null
//   'partial'    one score entered
//   'confirmed'  both entered AND a valid finished game
//   'mismatch'   both entered but NOT valid (e.g. not won by 2) — needs fixing

import { getStore } from '@netlify/blobs';
import { requireCaptain, unauthResponse } from './lib/captain-auth.js';
import { rebuildStandings } from './lib/standings.js';

const SLOT_RULES = {
  r1g1: { round: 1, game: 1 }, r1g2: { round: 1, game: 2 },
  r1g3: { round: 1, game: 3 }, r1g4: { round: 1, game: 4 },
  r1g5: { round: 1, game: 5 }, r1g6: { round: 1, game: 6 },
  r2g1: { round: 2, game: 1 }, r2g2: { round: 2, game: 2 },
  r2g3: { round: 2, game: 3 }, r2g4: { round: 2, game: 4 },
  r2g5: { round: 2, game: 5 }, r2g6: { round: 2, game: 6 },
};
const SLOT_KEYS = Object.keys(SLOT_RULES);

const PAIRS = [
  { id: 'r1p1', slots: ['r1g1','r1g2'], round: 1, pair: 1, label: 'Pair 1 · G1+G2' },
  { id: 'r1p2', slots: ['r1g3','r1g4'], round: 1, pair: 2, label: 'Pair 2 · G3+G4' },
  { id: 'r1p3', slots: ['r1g5','r1g6'], round: 1, pair: 3, label: 'Pair 3 · G5+G6' },
  { id: 'r2p1', slots: ['r2g1','r2g2'], round: 2, pair: 1, label: 'Pair 1 · G1+G2' },
  { id: 'r2p2', slots: ['r2g3','r2g4'], round: 2, pair: 2, label: 'Pair 2 · G3+G4' },
  { id: 'r2p3', slots: ['r2g5','r2g6'], round: 2, pair: 3, label: 'Pair 3 · G5+G6' },
];

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const scheduleStore = getStore('schedule');
  const scoresStore = getStore('scores');
  const lineupStore = getStore('lineups');
  const seasonStore = getStore('seasons');
  const seasonData = ctx.team.seasonId
    ? await seasonStore.get(ctx.team.seasonId, { type: 'json' }).catch(() => null)
    : null;
  const WEEKS = seasonData?.weeks || 8;

  const match = await findMatch(scheduleStore, matchId, ctx.team, WEEKS);
  if (!match) return json({ error: 'Match not found or not yours' }, 404);

  const myRole = match.teamA.id === ctx.team.id ? 'home' : 'away';
  const scoreKey = `score/${matchId}.json`;

  const [lineupHome, lineupAway] = await Promise.all([
    lineupStore.get(`lineup/${matchId}/${match.teamA.id}.json`, { type: 'json' }).catch(() => null),
    lineupStore.get(`lineup/${matchId}/${match.teamB.id}.json`, { type: 'json' }).catch(() => null),
  ]);
  const revealed = !!lineupHome?.lockedAt && !!lineupAway?.lockedAt;

  // ===== GET =====
  if (req.method === 'GET') {
    if (!revealed) {
      return json({
        matchId, myRole, revealed: false,
        message: 'Both lineups must be locked before scoring.',
      });
    }
    const score = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);

    return json({
      matchId, myRole, revealed: true,
      match: publicMatchInfo(match),
      homeLineup: sanitizeLineup(lineupHome),
      awayLineup: sanitizeLineup(lineupAway),
      score: decorate(score),
    });
  }

  if (!revealed) return json({ error: 'Both lineups must be locked before scoring' }, 409);

  // ===== PUT =====
  if (req.method === 'PUT') {
    const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);

    if (existing.finalizedAt) {
      return json({ error: 'Match is final. Contact admin to reopen.' }, 409);
    }

    const body = await req.json();
    const incoming = body.games || {};
    const now = new Date().toISOString();
    let changed = false;

    // Single shared scoresheet: either captain may enter/edit any game's
    // home + away scores. Incoming per slot: { home?: N|null, away?: M|null }.
    for (const slot of SLOT_KEYS) {
      if (!(slot in incoming)) continue;
      const g = incoming[slot] || {};
      if (!existing.games[slot]) existing.games[slot] = { home: null, away: null };
      const cur = existing.games[slot];
      let slotChanged = false;

      for (const side of ['home', 'away']) {
        if (!(side in g)) continue;
        const raw = g[side];
        const newVal = (raw === '' || raw === null || raw === undefined) ? null : toScore(raw);
        if (newVal === 'INVALID') {
          return json({ error: `${prettySlot(slot)}: scores must be integers 0-30` }, 400);
        }
        if (cur[side] === newVal) continue; // no change
        cur[side] = newVal;
        slotChanged = true;
      }

      if (slotChanged) {
        cur.by = ctx.user.email;
        cur.at = now;
        changed = true;
      }
    }

    // Any score change wipes both submit flags — both captains must re-approve.
    if (changed && (existing.homeSubmittedAt || existing.awaySubmittedAt)) {
      existing.homeSubmittedAt = null;
      existing.homeSubmittedBy = null;
      existing.awaySubmittedAt = null;
      existing.awaySubmittedBy = null;
    }

    existing.updatedAt = now;
    existing.updatedBy = ctx.user.email;

    await scoresStore.setJSON(scoreKey, existing);
    return json({ ok: true, score: decorate(existing) });
  }

  // ===== POST submit / withdraw =====
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');
    if (!['submit', 'withdraw'].includes(action)) {
      return json({ error: 'action must be submit or withdraw' }, 400);
    }

    const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);

    if (action === 'submit') {
      if (existing.finalizedAt) {
        return json({ error: 'Already finalized' }, 409);
      }
      // All games must be CONFIRMED (both sides match)
      const decorated = decorate(existing);
      const unconfirmed = decorated.computed.gameStatuses.filter(g => g.status !== 'confirmed');
      if (unconfirmed.length > 0) {
        const labels = unconfirmed.map(g => prettySlot(g.slot)).slice(0, 3).join(', ');
        const more = unconfirmed.length > 3 ? ` and ${unconfirmed.length - 3} more` : '';
        return json({
          error: `Cannot submit yet — ${unconfirmed.length} game(s) need a complete, valid score (first to 11): ${labels}${more}.`,
        }, 400);
      }

      const now = new Date().toISOString();
      if (myRole === 'home') {
        existing.homeSubmittedAt = now;
        existing.homeSubmittedBy = ctx.user.email;
      } else {
        existing.awaySubmittedAt = now;
        existing.awaySubmittedBy = ctx.user.email;
      }

      // Both submitted → finalize and write to schedule
      if (existing.homeSubmittedAt && existing.awaySubmittedAt) {
        existing.finalizedAt = now;
        await writeFinalScoreToSchedule(scheduleStore, match, existing);
        // Rebuild standings + player-stats aggregates for this Circuit.
        // Wrapped so a standings error doesn't block the finalize itself.
        rebuildStandings(match.circuit).catch(err =>
          console.error('rebuildStandings failed post-finalize:', err)
        );
      }
    } else {
      // Withdraw
      if (existing.finalizedAt) {
        return json({ error: 'Match is finalized. Contact admin to reopen.' }, 409);
      }
      if (myRole === 'home') {
        existing.homeSubmittedAt = null;
        existing.homeSubmittedBy = null;
      } else {
        existing.awaySubmittedAt = null;
        existing.awaySubmittedBy = null;
      }
    }

    await scoresStore.setJSON(scoreKey, existing);
    return json({ ok: true, score: decorate(existing) });
  }

  return new Response('Method not allowed', { status: 405 });
};

// ===== Helpers =====

async function findMatch(scheduleStore, matchId, team, weeks = 8) {
  for (let week = 1; week <= weeks; week++) {
    const key = `schedule/${team.circuit}/${team.division}/week-${week}.json`;
    const data = await scheduleStore.get(key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m && (m.teamA?.id === team.id || m.teamB?.id === team.id)) {
      return { ...m, week, circuit: team.circuit, division: team.division, scheduleKey: key };
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

function toScore(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 30) return 'INVALID';
  return n;
}

function gameStatus(game) {
  const hHas = Number.isInteger(game?.home);
  const aHas = Number.isInteger(game?.away);
  if (!hHas && !aHas) return 'empty';
  if (!hHas || !aHas) return 'partial';
  // Both scores entered → 'confirmed' if it's a legal finished game, else 'mismatch'
  // ('mismatch' = entered but not a valid result, e.g. not won by 2).
  return isValidGame(game.home, game.away) ? 'confirmed' : 'mismatch';
}

// Dink Society format: games are first-to-11, win by 1 — the winner's score
// is exactly 11 and the loser is 0–10. (Championship/gold games to 15 are not
// special-cased here yet.)
function isValidGame(h, a) {
  if (!Number.isInteger(h) || !Number.isInteger(a)) return false;
  if (h === a) return false;                 // must have a winner
  const hi = Math.max(h, a), lo = Math.min(h, a);
  if (hi !== 11) return false;               // winner reaches exactly 11
  if (lo < 0 || lo > 10) return false;       // loser 0–10
  return true;
}

function decorate(score) {
  // Status per game
  const gameStatuses = SLOT_KEYS.map(slot => ({
    slot,
    status: gameStatus(score.games[slot]),
  }));

  const counts = gameStatuses.reduce((acc, g) => {
    acc[g.status] = (acc[g.status] || 0) + 1;
    return acc;
  }, { empty: 0, partial: 0, confirmed: 0, mismatch: 0 });

  // Round + match points (only count CONFIRMED games for round wins)
  const r1 = computeRound(score.games, 1, gameStatuses);
  const r2 = computeRound(score.games, 2, gameStatuses);
  const matchHome = r1.homePoints + r2.homePoints;
  const matchAway = r1.awayPoints + r2.awayPoints;
  const matchWinner = matchHome > matchAway ? 'home'
    : matchAway > matchHome ? 'away' : 'tie';

  const allConfirmed = counts.confirmed === 12;

  // Pair-level status
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
      locked: false, // single-entry: no pair-sequential locking
      state: allConf ? 'confirmed'
           : hasMismatch ? 'mismatch'
           : hasPartial ? 'active'
           : 'pending',
    });
  }

  const canSubmit = allConfirmed;

  return {
    ...score,
    computed: {
      gameStatuses,
      counts,
      round1: r1,
      round2: r2,
      matchPoints: { home: matchHome, away: matchAway },
      matchWinner,
      allConfirmed,
      canSubmit,
      mismatches: gameStatuses.filter(g => g.status === 'mismatch').map(g => g.slot),
      unentered: gameStatuses.filter(g => g.status === 'empty' || g.status === 'partial').map(g => g.slot),
      pairStatuses,
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
    const h = gs.home;
    const a = gs.away;
    scored++;
    if (h > a) homeGames++;
    else if (a > h) awayGames++;
  }
  let homePoints = 0, awayPoints = 0;
  if (scored === 6) {
    if (homeGames > awayGames) homePoints = 2;
    else if (awayGames > homeGames) awayPoints = 2;
    else { homePoints = 1; awayPoints = 1; }
  }
  return { homeGames, awayGames, homePoints, awayPoints, scoredGames: scored };
}

function sanitizeLineup(lineup) {
  if (!lineup) return null;
  return { teamId: lineup.teamId, teamName: lineup.teamName, games: lineup.games };
}

function publicMatchInfo(match) {
  return {
    id: match.id, week: match.week, court: match.court,
    venue: match.venue || null,
    scheduledAt: match.scheduledAt || null,
    circuit: match.circuit, division: match.division,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
  };
}

async function writeFinalScoreToSchedule(scheduleStore, match, score) {
  const data = await scheduleStore.get(match.scheduleKey, { type: 'json' });
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

function prettySlot(slot) {
  const round = slot.startsWith('r1') ? 'R1' : 'R2';
  const game = slot.slice(-1);
  return `${round}G${game}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-score' };