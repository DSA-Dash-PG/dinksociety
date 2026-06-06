// tests/score.test.js
// Minimal unit tests for the pure scoring helpers extracted in Task 1.4.
// Run with: npm test   (Node's built-in test runner — no dependencies)
//
// League rules under test (see lib/score-helpers.js):
//   Regular season: first to exactly 11, win by 1 (winner scores exactly 11).
//   Championship:   first to 11, win by 2 — 11–9 or better, or deuce ending
//                   on exactly a 2-point lead (12–10, 13–11, …).

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
} from '../netlify/functions/lib/score-helpers.js';

// Helper: a fake match shaped like the schedule blobs captain-score reads.
function fakeMatch() {
  return {
    id: 'm1', circuit: 'I', division: 'test-mixed', week: 1, championship: false,
    teamA: { id: 'home-team', name: 'Home' },
    teamB: { id: 'away-team', name: 'Away' },
  };
}

test('basic win: 11–7 is a valid regular-season game and reads as confirmed', () => {
  assert.equal(isValidGame(11, 7), true);
  assert.equal(gameStatus({ home: 11, away: 7 }), 'confirmed');
});

test('basic loss: away side winning 7–11 is valid and scores the round for away', () => {
  assert.equal(isValidGame(7, 11), true);
  // A full round of 6 games, away wins all → away gets the 2 round points.
  const games = {};
  for (let g = 1; g <= 6; g++) games[`r1g${g}`] = { home: 5, away: 11 };
  const statuses = Object.keys(games).map(slot => ({ slot, status: gameStatus(games[slot]) }));
  const round = computeRound(games, 1, statuses);
  assert.deepEqual(
    { homeGames: round.homeGames, awayGames: round.awayGames, homePoints: round.homePoints, awayPoints: round.awayPoints },
    { homeGames: 0, awayGames: 6, homePoints: 0, awayPoints: 2 }
  );
});

test('tie: a game cannot end level — 11–11 is invalid and flags as mismatch', () => {
  assert.equal(isValidGame(11, 11), false);
  assert.equal(gameStatus({ home: 11, away: 11 }), 'mismatch');
});

test('tied round: 3 games each → both sides get 1 round point', () => {
  const games = {};
  for (let g = 1; g <= 3; g++) games[`r1g${g}`] = { home: 11, away: 8 };
  for (let g = 4; g <= 6; g++) games[`r1g${g}`] = { home: 8, away: 11 };
  const statuses = Object.keys(games).map(slot => ({ slot, status: gameStatus(games[slot]) }));
  const round = computeRound(games, 1, statuses);
  assert.equal(round.homePoints, 1);
  assert.equal(round.awayPoints, 1);
});

test('missing score: one side entered → partial; nothing entered → empty; round awards no points until all 6 games confirmed', () => {
  assert.equal(gameStatus({ home: 11, away: null }), 'partial');
  assert.equal(gameStatus({ home: null, away: null }), 'empty');

  // 5 confirmed games + 1 missing → no round points yet.
  const games = {};
  for (let g = 1; g <= 5; g++) games[`r1g${g}`] = { home: 11, away: 3 };
  games.r1g6 = { home: null, away: null };
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

test('decorate: a fully-entered match computes winner, allows submit, and lists no mismatches', () => {
  const record = newScoreRecord(fakeMatch());
  // Home wins every game 11–6 across both rounds.
  for (const slot of SLOT_KEYS) record.games[slot] = { home: 11, away: 6 };

  const d = decorate(record, false);
  assert.equal(d.computed.allConfirmed, true);
  assert.equal(d.computed.canSubmit, true);
  assert.deepEqual(d.computed.matchPoints, { home: 4, away: 0 });
  assert.equal(d.computed.matchWinner, 'home');
  assert.deepEqual(d.computed.mismatches, []);
  assert.deepEqual(d.computed.unentered, []);
  assert.equal(d.computed.counts.confirmed, 12);
});
