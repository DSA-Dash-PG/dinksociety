// tests/score.test.js
// Unit tests for the pure scoring helpers (dual-entry verification model).
// Run with: npm test   (Node's built-in test runner — no dependencies)
//
// League rules under test (see lib/score-helpers.js):
//   Regular season: first to exactly 11, win by 1 (winner scores exactly 11).
//   Championship:   first to 11, win by 2 — 11–9 or better, or deuce ending
//                   on exactly a 2-point lead (12–10, 13–11, …).
//
// Dual-entry model: each team enters its own copy of every game score.
// A game is 'confirmed' only when both versions match and form a valid game.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_KEYS,
  isValidGame,
  gameStatus,
  toScore,
  computeRound,
  decorate,
  newScoreRecord,
  migrateGame,
  normalizeScore,
  entryComplete,
} from '../netlify/functions/lib/score-helpers.js';

// Helper: a fake match shaped like the schedule blobs captain-score reads.
function fakeMatch() {
  return {
    id: 'm1', circuit: 'I', division: 'test-mixed', week: 1, championship: false,
    teamA: { id: 'home-team', name: 'Home' },
    teamB: { id: 'away-team', name: 'Away' },
  };
}

// Helper: both teams entered the same score (agreed game).
function agreed(home, away) {
  return {
    home: null, away: null,
    homeEntry: { home, away, by: 'home@x.com', at: 't' },
    awayEntry: { home, away, by: 'away@x.com', at: 't' },
  };
}

// Helper: the two teams entered different scores (mismatch).
function disputed(homeVersion, awayVersion) {
  return {
    home: null, away: null,
    homeEntry: { home: homeVersion[0], away: homeVersion[1], by: 'home@x.com', at: 't' },
    awayEntry: { home: awayVersion[0], away: awayVersion[1], by: 'away@x.com', at: 't' },
  };
}

test('basic win: 11–7 entered identically by both teams reads as confirmed', () => {
  assert.equal(isValidGame(11, 7), true);
  assert.equal(gameStatus(agreed(11, 7)), 'confirmed');
});

test('cross-check: both teams entered but versions DISAGREE → mismatch', () => {
  const g = disputed([11, 7], [11, 9]);
  assert.equal(gameStatus(g), 'mismatch');
});

test('one-sided entry: only the home team has entered → partial (not confirmed)', () => {
  const g = {
    home: null, away: null,
    homeEntry: { home: 11, away: 7, by: 'home@x.com', at: 't' },
    awayEntry: null,
  };
  assert.equal(gameStatus(g), 'partial');
  assert.equal(entryComplete(g.homeEntry), true);
  assert.equal(entryComplete(g.awayEntry), false);
});

test('basic loss: away winning 7–11 agreed by both → away takes the round', () => {
  assert.equal(isValidGame(7, 11), true);
  const games = {};
  for (let g = 1; g <= 6; g++) games[`r1g${g}`] = agreed(5, 11);
  normalizeScore({ games }, false);
  const statuses = Object.keys(games).map(slot => ({ slot, status: gameStatus(games[slot]) }));
  const round = computeRound(games, 1, statuses);
  assert.deepEqual(
    { homeGames: round.homeGames, awayGames: round.awayGames, homePoints: round.homePoints, awayPoints: round.awayPoints },
    { homeGames: 0, awayGames: 6, homePoints: 0, awayPoints: 2 }
  );
});

test('tie: a game cannot end level — agreed 11–11 is invalid and flags as mismatch', () => {
  assert.equal(isValidGame(11, 11), false);
  assert.equal(gameStatus(agreed(11, 11)), 'mismatch');
});

test('tied round: 3 games each → both sides get 1 round point', () => {
  const games = {};
  for (let g = 1; g <= 3; g++) games[`r1g${g}`] = agreed(11, 8);
  for (let g = 4; g <= 6; g++) games[`r1g${g}`] = agreed(8, 11);
  normalizeScore({ games }, false);
  const statuses = Object.keys(games).map(slot => ({ slot, status: gameStatus(games[slot]) }));
  const round = computeRound(games, 1, statuses);
  assert.equal(round.homePoints, 1);
  assert.equal(round.awayPoints, 1);
});

test('missing score: in-progress entry → partial; nothing entered → empty; round needs 6 confirmed games', () => {
  assert.equal(gameStatus({ home: null, away: null, homeEntry: { home: 11, away: null, by: 'x', at: 't' }, awayEntry: null }), 'partial');
  assert.equal(gameStatus({ home: null, away: null, homeEntry: null, awayEntry: null }), 'empty');

  // 5 confirmed games + 1 missing → no round points yet.
  const games = {};
  for (let g = 1; g <= 5; g++) games[`r1g${g}`] = agreed(11, 3);
  games.r1g6 = { home: null, away: null, homeEntry: null, awayEntry: null };
  normalizeScore({ games }, false);
  const statuses = Object.keys(games).map(slot => ({ slot, status: gameStatus(games[slot]) }));
  const round = computeRound(games, 1, statuses);
  assert.equal(round.scoredGames, 5);
  assert.equal(round.homePoints, 0);
  assert.equal(round.awayPoints, 0);
});

test('edge case: championship win-by-2 deuce rules', () => {
  // Regular season: winner must land on exactly 11 — 12–10 is NOT valid.
  assert.equal(isValidGame(12, 10, 1), false);
  // Championship (winBy = 2): 12–10 deuce IS valid…
  assert.equal(isValidGame(12, 10, 2), true);
  // …but 11–10 isn't (not won by 2), and 13–10 isn't (deuce must end on +2 exactly).
  assert.equal(isValidGame(11, 10, 2), false);
  assert.equal(isValidGame(13, 10, 2), false);
  // 11–9 is the clean championship win.
  assert.equal(isValidGame(11, 9, 2), true);
});

test('toScore: parses valid entries, nulls blanks, rejects out-of-range', () => {
  assert.equal(toScore('11'), 11);
  assert.equal(toScore(0), 0);
  assert.equal(toScore(''), null);
  assert.equal(toScore(null), null);
  assert.equal(toScore(31), 'INVALID');
  assert.equal(toScore(2.5), 'INVALID');
  assert.equal(toScore('abc'), 'INVALID');
});

test('legacy migration: old single-sheet { home, away } records read as agreed by both teams', () => {
  const g = migrateGame({ home: 11, away: 7, by: 'someone@x.com', at: 't' });
  assert.equal(gameStatus(g), 'confirmed');
  // Old admin shape { home: { entered } } also migrates.
  const ga = migrateGame({ home: { entered: 11, by: 'a', at: 't' }, away: { entered: 4, by: 'a', at: 't' } });
  assert.equal(gameStatus(ga), 'confirmed');
});

test('normalizeScore: canonical agreed score is set only for confirmed games', () => {
  const games = {
    r1g1: agreed(11, 6),
    r1g2: disputed([11, 7], [11, 9]),
  };
  normalizeScore({ games }, false);
  assert.equal(games.r1g1.home, 11);
  assert.equal(games.r1g1.away, 6);
  assert.equal(games.r1g2.home, null);
  assert.equal(games.r1g2.away, null);
});

test('decorate: a fully-agreed match computes winner, allows submit, and lists no mismatches', () => {
  const record = newScoreRecord(fakeMatch());
  // Home wins every game 11–6 across both rounds — both teams agree.
  for (const slot of SLOT_KEYS) record.games[slot] = agreed(11, 6);

  const d = decorate(record, false);
  assert.equal(d.computed.allConfirmed, true);
  assert.equal(d.computed.canSubmit, true);
  assert.deepEqual(d.computed.matchPoints, { home: 4, away: 0 });
  assert.equal(d.computed.matchWinner, 'home');
  assert.deepEqual(d.computed.mismatches, []);
  assert.deepEqual(d.computed.unentered, []);
  assert.equal(d.computed.counts.confirmed, 12);
});

test('decorate: a single disputed game blocks submit and is listed as a mismatch', () => {
  const record = newScoreRecord(fakeMatch());
  for (const slot of SLOT_KEYS) record.games[slot] = agreed(11, 6);
  record.games.r2g3 = disputed([11, 6], [11, 8]);

  const d = decorate(record, false);
  assert.equal(d.computed.allConfirmed, false);
  assert.equal(d.computed.canSubmit, false);
  assert.deepEqual(d.computed.mismatches, ['r2g3']);
});
