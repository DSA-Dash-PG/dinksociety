// tests/ladder-round-robin.test.js
// Round Robin (block-movement) ladder engine — lib/ladder-scoring.js
// genR1Block / genNRBlock / pickRotation / blockStandings.
// Run: node --test tests/ladder-round-robin.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  genR1Block, genNRBlock, pickRotation, blockStandings, partnerKeys, BLOCK_ROUNDS,
} from '../netlify/functions/lib/ladder-scoring.js';

const P = ['Al', 'Bo', 'Cy', 'Dan', 'Ed', 'Fil', 'Gus', 'Hal'].map((n, i) => ({ id: 'p' + i, name: n, gender: 'M' }));
const ids = r => r.courts.flatMap(c => [...c.team1, ...c.team2].filter(Boolean).map(p => p.id));
const onCourt = (r, ci) => new Set([...r.courts[ci].team1, ...r.courts[ci].team2].filter(Boolean).map(p => p.id));

// Score every court: team1 wins by `margin` (or team2 when margin < 0).
function score(round, pick) {
  round.courts.forEach((c, ci) => {
    const m = pick(ci, c);
    c.score = m > 0 ? { t1: 11, t2: 11 - m, winner: 'A' } : { t1: 11 + m, t2: 11, winner: 'B' };
  });
}

test('genR1Block: 8 players → 2 courts of 4, no one dropped or duplicated', () => {
  const r1 = genR1Block(P, 2);
  assert.equal(r1.courts.length, 2);
  assert.equal(r1.totalCourts, 2);
  const all = ids(r1);
  assert.equal(all.length, 8);
  assert.equal(new Set(all).size, 8);
  r1.courts.forEach(c => { assert.equal(c.team1.filter(Boolean).length, 2); assert.equal(c.team2.filter(Boolean).length, 2); assert.equal(c.score, null); });
});

test('pickRotation: avoids partners already used this block; 3rd game leaves exactly one combo', () => {
  const [a, b, c, d] = P;
  const used = new Set(['p0-p1', 'p2-p3', 'p0-p2', 'p1-p3']); // AB·CD and AC·BD played
  for (let i = 0; i < 20; i++) {
    const { t1, t2 } = pickRotation([a, b, c, d], used);
    const key = t => [t[0].id, t[1].id].sort().join('-');
    assert.deepEqual([key(t1), key(t2)].sort(), ['p0-p3', 'p1-p2']); // only AD·BC remains
  }
});

test('inside a block: same courts every game, every partner combo used exactly once', () => {
  for (let trial = 0; trial < 50; trial++) {
    const rounds = [genR1Block(P, 2)];
    for (let r = 1; r < BLOCK_ROUNDS; r++) {
      score(rounds[r - 1], () => (Math.random() < 0.5 ? 3 : -3));
      rounds.push(genNRBlock(rounds, 2, {}));
    }
    for (let ci = 0; ci < 2; ci++) {
      const base = onCourt(rounds[0], ci);
      for (let r = 1; r < BLOCK_ROUNDS; r++) assert.deepEqual(onCourt(rounds[r], ci), base, 'court changed mid-block');
      const keys = partnerKeys(rounds.map(r => ({ courts: [r.courts[ci]] })));
      assert.equal(keys.size, 6, 'a partner combo repeated inside the block');
    }
  }
});

test('block boundary: top 2 of the lower court move up, bottom 2 of the top court move down', () => {
  // Fix the block so the standings are unambiguous: on court 1 (bottom),
  // team1 wins every game by 5; on court 2 (top), team2 wins every game by 5.
  const rounds = [genR1Block(P, 2)];
  for (let r = 1; r <= BLOCK_ROUNDS; r++) {
    score(rounds[r - 1], ci => (ci === 0 ? 5 : -5));
    if (r < BLOCK_ROUNDS) rounds.push(genNRBlock(rounds, 2, {}));
  }
  // Because partners rotate, "team1 wins every game" gives every player on a
  // court a mixed record — so instead compute the block standings and assert
  // the movement matches them exactly (ties broken by DR map here).
  const st = blockStandings(rounds);
  const dr = { p0: 90, p1: 80, p2: 70, p3: 60, p4: 50, p5: 40, p6: 30, p7: 20 };
  const rank = set => [...set].sort((a, b) => (st[b].w - st[a].w) || (st[b].diff - st[a].diff) || (dr[b] - dr[a]));
  const c1 = rank(onCourt(rounds[2], 0)), c2 = rank(onCourt(rounds[2], 1));
  const next = genNRBlock(rounds, 2, dr);
  assert.equal(rounds.length, 3);
  const n1 = onCourt(next, 0), n2 = onCourt(next, 1);
  assert.ok(n2.has(c1[0]) && n2.has(c1[1]), 'court 1 top 2 should be on court 2');
  assert.ok(n1.has(c1[2]) && n1.has(c1[3]), 'court 1 bottom 2 should stay on court 1');
  assert.ok(n2.has(c2[0]) && n2.has(c2[1]), 'court 2 top 2 should stay on court 2');
  assert.ok(n1.has(c2[2]) && n1.has(c2[3]), 'court 2 bottom 2 should drop to court 1');
  assert.equal(n1.size, 4); assert.equal(n2.size, 4);
});

test('DR is the third tiebreak at a boundary (after wins → diff)', () => {
  // Hand-build a block where two court-1 players are identical on wins and
  // diff; only DR separates them.
  const [a, b, c, d] = P;
  const g = (t1, t2, s) => ({ court: 1, team1: t1, team2: t2, score: s });
  const rounds = [
    { courts: [g([a, b], [c, d], { t1: 11, t2: 5, winner: 'A' })] }, // a,b +6
    { courts: [g([a, c], [b, d], { t1: 11, t2: 5, winner: 'A' })] }, // a,c +6 ; b,d −6
    { courts: [g([a, d], [b, c], { t1: 5, t2: 11, winner: 'B' })] }, // b,c +6 ; a,d −6
  ];
  // a: 2-1 +6 · b: 2-1 +6 · c: 2-1 +6 · d: 0-3 −18 — a/b/c tied, DR decides.
  const st = blockStandings(rounds);
  assert.deepEqual([st.p0.w, st.p1.w, st.p2.w, st.p3.w], [2, 2, 2, 0]);
  // Single court: nobody can actually move (top court == bottom court), so
  // check the ranking primitive directly via a 2-court arrangement instead.
  const rounds2 = rounds.map(r => ({ courts: [r.courts[0], { court: 2, team1: [P[4], P[5]], team2: [P[6], P[7]], score: { t1: 11, t2: 0, winner: 'A' } }] }));
  const next = genNRBlock(rounds2, 2, { p0: 10, p1: 50, p2: 90, p3: 0 });
  const up = onCourt(next, 1);
  assert.ok(up.has('p2') && up.has('p1'), 'highest-DR pair of the tied three moves up');
  assert.ok(!up.has('p0'), 'lowest-DR of the tied three stays');
});

test('full 9-round night: every game seats all 8, never drops or duplicates', () => {
  for (let trial = 0; trial < 100; trial++) {
    const rounds = [genR1Block(P, 2)];
    for (let r = 1; r < 9; r++) {
      score(rounds[r - 1], () => (Math.random() < 0.5 ? 4 : -4));
      rounds.push(genNRBlock(rounds, 2, {}));
    }
    rounds.forEach(r => { const all = ids(r); assert.equal(all.length, 8); assert.equal(new Set(all).size, 8); });
  }
});
