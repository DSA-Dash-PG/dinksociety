// tests/ladder-scoring.test.js
// Parity tests for the ported run-night engine (lib/ladder-scoring.js). Locks the
// stats + Dink Rating behavior so it can't drift from the Pickleladder original.
// Pure module (no deps) — run: node --test tests/ladder-scoring.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCoed, calcStats, calcBonusPts, calcDinkRating, calcPartners, getRoundMVPs,
} from '../netlify/functions/lib/ladder-scoring.js';

const A = { id: 'A', name: 'Al', gender: 'M' };
const B = { id: 'B', name: 'Bo', gender: 'M' };
const C = { id: 'C', name: 'Cy', gender: 'F' };
const D = { id: 'D', name: 'Di', gender: 'F' };
const players = [A, B, C, D];

// One night, one court, two rounds.
const sessions = [{
  id: 's1', date: '2026-06-10',
  rounds: [
    { courts: [{ court: 1, team1: [A, C], team2: [B, D], score: { t1: 11, t2: 7, winner: 'A' } }] },
    { courts: [{ court: 1, team1: [A, D], team2: [B, C], score: { t1: 9, t2: 11, winner: 'B' } }] },
  ],
}];

test('makeCoed keeps 2M+2F mixed (one M + one F per team)', () => {
  const { t1, t2 } = makeCoed([A, B, C, D], null, () => 0);
  const mixed = team => team.filter(Boolean).map(p => p.gender).sort().join('');
  assert.equal(mixed(t1), 'FM');
  assert.equal(mixed(t2), 'FM');
});

test('calcStats: records, points, sort by pf then diff', () => {
  const s = calcStats(sessions, players);
  const by = Object.fromEntries(s.map(x => [x.id, x]));
  assert.deepEqual([by.A.w, by.A.l, by.A.pf, by.A.pa], [1, 1, 20, 18]);
  assert.deepEqual([by.B.w, by.B.l, by.B.pf, by.B.pa], [1, 1, 18, 20]);
  assert.deepEqual([by.C.w, by.C.l, by.C.pf, by.C.pa], [2, 0, 22, 16]);
  assert.deepEqual([by.D.w, by.D.l, by.D.pf, by.D.pa], [0, 2, 16, 22]);
  assert.equal(by.A.attended, 1);
  // sorted: C(22) A(20) B(18) D(16)
  assert.deepEqual(s.map(x => x.id), ['C', 'A', 'B', 'D']);
});

test('calcBonusPts: podium 15/10/5 by points then diff', () => {
  const bonus = calcBonusPts(sessions, players);
  assert.equal(bonus.C.bonus, 15);
  assert.equal(bonus.C.wins, 1);
  assert.equal(bonus.A.bonus, 10);
  assert.equal(bonus.B.bonus, 5);
  assert.equal(bonus.D.bonus, 0);
});

test('calcDinkRating: number for players with games, snapshot locks parity', () => {
  const stats = calcStats(sessions, players);
  const dr = calcDinkRating(stats, sessions, players);
  for (const id of ['A', 'B', 'C', 'D']) {
    assert.equal(typeof dr[id], 'number');
    assert.ok(dr[id] >= 0 && dr[id] <= 100);
  }
  // Undefeated C should out-rate winless D.
  assert.ok(dr.C > dr.D);
  // Lock the exact top value so any drift from the ported formula is caught.
  assert.equal(dr.C, 88.2);
});

test('calcDinkRating: null for players with no games', () => {
  const E = { id: 'E', name: 'Ed', gender: 'M' };
  const stats = calcStats(sessions, [...players, E]);
  const dr = calcDinkRating(stats, sessions, [...players, E]);
  assert.equal(dr.E, null);
});

test('calcPartners + getRoundMVPs run over the fixture', () => {
  const parts = calcPartners(sessions, players);
  assert.ok(parts.length >= 1);
  const mvps = getRoundMVPs(sessions[0].rounds[0], players);
  assert.ok(mvps.male.length >= 1 || mvps.female.length >= 1);
});
