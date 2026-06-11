// tests/drop-insights.test.js
// Unit tests for the pure "story fodder" helpers behind The Drop generator.
// Run with: npm test  (Node's built-in runner — no dependencies)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimelines, computeStreaks, detectUpsets, detectBlowouts, latestPlayedWeek,
} from '../netlify/functions/lib/drop-stats.js';

// Helper to make a match record in the flattened shape loadFinalizedMatches emits.
function m(week, division, aId, aName, bId, bName, pa, pb) {
  return {
    week, division,
    a: { id: aId, name: aName }, b: { id: bId, name: bName },
    pa, pb, gamesA: pa === 4 ? 4 : pa, gamesB: pb === 4 ? 0 : pb,
    sweep: (pa === 4 && pb === 0) || (pb === 4 && pa === 0),
    finalizedAt: '2026-06-0' + week + 'T22:00:00Z', scheduledAt: '2026-06-0' + week + 'T19:00:00Z',
  };
}

// A small 3-team, 3-week season.
//   wk1: Aces 4–0 Bangers (sweep) · (Cobras bye)
//   wk2: Aces 3–1 Cobras            · (Bangers bye)
//   wk3: Bangers 3–1 Aces (UPSET: Aces were unbeaten) · (Cobras bye)
const MATCHES = [
  m(1, 'D', 'aces', 'Aces', 'bang', 'Bangers', 4, 0),
  m(2, 'D', 'aces', 'Aces', 'cobr', 'Cobras', 3, 1),
  m(3, 'D', 'bang', 'Bangers', 'aces', 'Aces', 3, 1),
];

test('latestPlayedWeek finds the max finalized week', () => {
  assert.equal(latestPlayedWeek(MATCHES), 3);
  assert.equal(latestPlayedWeek([]), 0);
});

test('buildTimelines orders each team by week with correct win flags', () => {
  const t = buildTimelines(MATCHES);
  const aces = t.get('aces');
  assert.equal(aces.games.length, 3);
  assert.deepEqual(aces.games.map(g => g.week), [1, 2, 3]);
  assert.deepEqual(aces.games.map(g => g.won), [true, true, false]);
});

test('computestreaks reports active win streaks, longest first; a loss resets', () => {
  const streaks = computeStreaks(buildTimelines(MATCHES));
  // Aces won wk1+wk2 then LOST wk3 → active streak 0 (not listed, <2).
  // Bangers lost wk1, won wk3 → streak 1 (<2, not listed).
  assert.equal(streaks.length, 0);

  // Now give Aces an unbroken run.
  const run = [
    m(1, 'D', 'aces', 'Aces', 'bang', 'Bangers', 3, 1),
    m(2, 'D', 'aces', 'Aces', 'cobr', 'Cobras', 4, 0),
    m(3, 'D', 'aces', 'Aces', 'bang', 'Bangers', 3, 1),
  ];
  const s2 = computeStreaks(buildTimelines(run));
  assert.equal(s2[0].name, 'Aces');
  assert.equal(s2[0].streak, 3);
});

test('detectUpsets flags a previously-unbeaten team losing', () => {
  const t = buildTimelines(MATCHES);
  const ups = detectUpsets(MATCHES, t, 3);
  assert.equal(ups.length, 1);
  assert.equal(ups[0].winner, 'Bangers');
  assert.equal(ups[0].loser, 'Aces');
  assert.equal(ups[0].loserWasUnbeaten, true);
  assert.equal(ups[0].score, '3–1');
});

test('detectUpsets ignores an expected result', () => {
  const t = buildTimelines(MATCHES);
  // Week 1: no prior history, Aces beat Bangers — not an upset.
  assert.equal(detectUpsets(MATCHES, t, 1).length, 0);
});

test('detectBlowouts returns only 4–0 sweeps for the week', () => {
  assert.deepEqual(detectBlowouts(MATCHES, 1).map(b => b.winner), ['Aces']);
  assert.equal(detectBlowouts(MATCHES, 3).length, 0);
});
