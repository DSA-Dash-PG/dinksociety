// Game-pace math (lib/pace.js) — built on Season 2 Week 1 real entry times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMatchPace, summarizePace, gameTiming } from '../netlify/functions/lib/pace.js';

const D = '2026-09-18T';
function rec(rows, adminAll = false) {
  const games = {};
  for (const [slot, h, a, hAt, aAt] of rows) {
    const he = { home: h, away: a, by: adminAll ? 'admin@x' : 'home@x', at: D + hAt + '.000Z' };
    const ae = { home: h, away: a, by: adminAll ? 'admin@x' : 'away@x', at: adminAll ? he.at : D + aAt + '.000Z' };
    games[slot] = { homeEntry: he, awayEntry: ae };
  }
  return { games, homeSubmittedAt: D + '02:45:44.000Z', awaySubmittedAt: D + '02:45:24.000Z' };
}
const match = { id: 'm1', week: 1, teamA: { id: 'bde', name: 'Big Dink Energy' }, teamB: { id: 'fp', name: 'FOURPLAY' }, scheduledAt: D + '01:00:00.000Z', courtA: '5', courtB: '6', court: 'Courts 5 & 6' };
const BDE = [
  ['r1g1', 11, 4, '01:26:19', '01:28:31'], ['r1g2', 11, 8, '01:27:52', '01:28:36'],
  ['r1g3', 11, 2, '01:36:21', '01:38:22'], ['r1g4', 11, 0, '01:35:12', '01:38:22'],
  ['r1g5', 11, 2, '01:56:17', '01:56:51'], ['r1g6', 9, 11, '01:56:21', '01:56:44'],
  ['r2g1', 6, 11, '02:10:03', '02:10:48'], ['r2g2', 11, 1, '02:04:13', '02:10:48'],
  ['r2g3', 11, 6, '02:25:36', '02:26:18'], ['r2g4', 11, 2, '02:21:45', '02:25:12'],
  ['r2g5', 11, 4, '02:40:15', '02:45:03'], ['r2g6', 11, 6, '02:36:59', '02:45:05'],
];

test('per-court durations from entry times', () => {
  const p = computeMatchPace(match, rec(BDE));
  const g = Object.fromEntries(p.games.map(x => [x.slot, x]));
  assert.equal(g.r1g1.min, 21.3);          // 6:05 → 6:26:19
  assert.ok(g.r1g1.flags.includes('fromStart'));
  assert.equal(g.r1g3.min, 10);            // 6:26:19 → 6:36:21 on court A
  assert.equal(g.r1g4.min, 7.3);           // court B
  assert.equal(p.totalMin, 95.3);
  assert.equal(p.round1Min, 51.4);
  assert.equal(p.timedGames, 12);
  assert.equal(g.r1g1.confirmLagMin, 2.2);
});

test('admin-stamped entries are not used as game clocks', () => {
  const p = computeMatchPace(match, rec(BDE, true));
  assert.equal(p.timedGames, 0);
  assert.equal(gameTiming({ homeEntry: { at: 'x', by: 'a' }, awayEntry: { at: 'x', by: 'a' } }).enteredAt, null);
});

test('timing field wins over entry stamps', () => {
  const r = rec(BDE, true);
  r.games.r1g1.timing = { enteredAt: D + '01:20:00.000Z' };
  const p = computeMatchPace(match, r);
  assert.equal(p.games[0].min, 15);
});

test('back-to-back entries on one court split evenly and are flagged', () => {
  const rows = BDE.map(r => [...r]);
  rows[4][3] = '01:36:40';                 // r1g5 entered 19s after r1g3
  const p = computeMatchPace(match, rec(rows));
  const g = Object.fromEntries(p.games.map(x => [x.slot, x]));
  assert.ok(g.r1g5.flags.includes('est'));
  assert.equal(g.r1g3.min, g.r1g5.min);
});

test('summary builds insights', () => {
  const s = summarizePace([computeMatchPace(match, rec(BDE))]);
  assert.ok(s.insights.length >= 3);
  assert.equal(s.teams.length, 2);
});
