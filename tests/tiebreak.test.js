// tests/tiebreak.test.js
// The league tiebreak order: PTS → GW → head-to-head (two-team ties only) → DIFF → PS.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortStandings } from '../netlify/functions/lib/tiebreak.js';
import { rankTeams } from '../netlify/functions/lib/bracket.js';

const F = {
  pts: t => t.pts, gw: t => t.gw, diff: t => t.diff, ps: t => t.ps, name: t => t.name,
  h2h: (a, b) => (a.h2h && a.h2h[b.name] != null ? a.h2h[b.name] : null),
};
const T = (name, pts, gw, diff, ps, h2h = {}) => ({ name, pts, gw, diff, ps, h2h });
const order = (rows) => sortStandings(rows, F).map(t => t.name).join(' ');
// every input order must give the same answer
function everyOrder(rows, expected) {
  const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
  for (const p of perms(rows)) assert.equal(order(p), expected);
}

test('points first, then games won', () => {
  everyOrder([T('A', 20, 50, -5, 400), T('B', 22, 40, -9, 380), T('C', 20, 55, -30, 300)], 'B C A');
});

test('two teams level on PTS and GW: head-to-head decides, even against a worse differential', () => {
  everyOrder([
    T('A', 20, 50, 40, 500, { B: 3 }),
    T('B', 20, 50, -10, 400, { A: 5 }),
    T('C', 10, 30, 0, 300),
  ], 'B A C');
});

test('two teams level that split head-to-head evenly, or have not met: differential, then points scored', () => {
  everyOrder([T('A', 20, 50, 12, 500, { B: 4 }), T('B', 20, 50, 30, 480, { A: 4 })], 'B A');
  everyOrder([T('A', 20, 50, 12, 500), T('B', 20, 50, 30, 480)], 'B A');
  everyOrder([T('A', 20, 50, 12, 500, { B: 4 }), T('B', 20, 50, 12, 520, { A: 4 })], 'B A');
});

test('three teams level in a circle: head-to-head is skipped, differential decides', () => {
  // A beat B, B beat C, C beat A — pairwise head-to-head has no answer.
  everyOrder([
    T('A', 20, 50, 5, 500, { B: 6, C: 2 }),
    T('B', 20, 50, 25, 480, { C: 6, A: 2 }),
    T('C', 20, 50, 15, 520, { A: 6, B: 2 }),
    T('D', 30, 60, 0, 400),
  ], 'D B C A');
});

test('three teams level: head-to-head is skipped even when one team swept the other two', () => {
  everyOrder([
    T('A', 20, 50, -8, 500, { B: 8, C: 8 }),
    T('B', 20, 50, 25, 480, { A: 0, C: 5 }),
    T('C', 20, 50, 15, 520, { A: 0, B: 3 }),
  ], 'B C A');
});

test('everything level: name keeps the order stable', () => {
  everyOrder([T('Bravo', 20, 50, 10, 500), T('Alpha', 20, 50, 10, 500), T('Charlie', 20, 50, 10, 500)], 'Alpha Bravo Charlie');
});

test('rankTeams (bracket seeding) follows the same order', () => {
  const tm = (id) => ({ id, name: id.toUpperCase() });
  const m = (week, a, b, mpA, mpB, gA, gB, pA, pB) => ({
    week, finalizedAt: 'x', teamA: tm(a), teamB: tm(b), scoreA: mpA, scoreB: mpB,
    round1: { homeGames: gA, awayGames: gB }, round2: { homeGames: 0, awayGames: 0 }, pointsA: pA, pointsB: pB,
  });
  // a, b, c each finish on 4 pts and 12 games in a circle (a>b, b>c, c>a); d is last.
  const matches = [
    m(1, 'a', 'b', 4, 0, 8, 4, 100, 60),   // a +40
    m(2, 'b', 'c', 4, 0, 8, 4, 100, 90),   // b +10 → net −30
    m(3, 'c', 'a', 4, 0, 8, 4, 100, 95),   // c +5 → net −5 ; a net +35
    m(4, 'a', 'd', 0, 0, 0, 0, 50, 50), m(4, 'b', 'd', 0, 0, 0, 0, 50, 50), m(4, 'c', 'd', 0, 0, 0, 0, 50, 50),
  ];
  const ranks = rankTeams({ matches, teamList: ['a', 'b', 'c', 'd'].map(tm), cutoffWeek: 10 }).map(t => t.id);
  assert.deepEqual(ranks, ['a', 'c', 'b', 'd']);     // by differential: +35, −5, −30
});
