// netlify/functions/captain-score.js
//
// Dual-entry scoring. Both captains enter every game. The system validates
// match-vs-mismatch. Match finalizes only when:
//   1. All 12 games have matching scores from both captains (CONFIRMED)
//   2. Both captains have tapped "Submit final" since the last edit
//
// GET   ?match=<id>                          → state + computed view
// PUT   ?match=<id>                          → save my entries (one captain at a time)
//                                                body: { games: { r1g1: { entered: 11 }, ... } }
// POST  ?match=<id>&action=submit            → mark this captain's "I'm done" flag
// POST  ?match=<id>&action=withdraw          → revoke my submit flag (only allowed pre-finalize)
//
// Storage shape:
//   game = { home: { entered, by, at }, away: { entered, by, at } }
//   game.home or game.away can be null = "this side hasn't entered"
//
// Computed status per game (server-derived, never persisted):
//   'empty'      both null
//   'partial'    one side null
//   'confirmed'  both set, equal
//   'mismatch'   both set, unequal

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

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const scheduleStore = getStore('schedule');
  const scoresStore = getStore('scores');
  const lineupStore = getStore('lineups');

  const match = await findMatch(scheduleStore, matchId, ctx.team);
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
    let mySideChanged = false;
    let otherSideEffectivelyChanged = false;

    for (const slot of SLOT_KEYS) {
      if (!(slot in incoming)) continue;
      const g = incoming[slot];

      // Initialize slot if missing
      if (!existing.games[slot]) existing.games[slot] = { home: null, away: null };

      // Read what THIS captain wants for this game
      const newVal = g === null ? null : (g.entered === '' || g.entered === null || g.entered === undefined ? null : toScore(g.entered));
      if (newVal === 'INVALID') {
        return json({ error: `${prettySlot(slot)}: scores must be integers 0-30` }, 400);
      }

      const sideKey = myRole; // 'home' or 'away'
      const currentSide = existing.games[slot][sideKey];

      if (newVal === null && currentSide === null) continue; // no change
      if (newVal !== null && currentSide && currentSide.entered === newVal) continue; // no change

      mySideChanged = true;
      if (newVal === null) {
        existing.games[slot][sideKey] = null;
      } else {
        existing.games[slot][sideKey] = {
          entered: newVal,
          by: ctx.user.email,
          at: now,
        };
      }
    }

    // Any score change wipes both submit flags — both captains must re-tap.
    if (mySideChanged && (existing.homeSubmittedAt || existing.awaySubmittedAt)) {
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
          error: `Cannot submit yet — ${unconfirmed.length} game(s) still need both captains to agree: ${labels}${more}.`,
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

async function findMatch(scheduleStore, matchId, team) {
  for (let week = 1; week <= 7; week++) {
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
  const h = game?.home;
  const a = game?.away;
  if (!h && !a) return 'empty';
  if (!h || !a) return 'partial';
  if (h.entered === a.entered) return 'confirmed';
  return 'mismatch';
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
    const h = gs.home.entered;
    const a = gs.away.entered;
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
