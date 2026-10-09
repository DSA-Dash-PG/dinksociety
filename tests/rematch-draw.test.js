// tests/rematch-draw.test.js
// The second round-robin draw (even or odd team count, byes). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawRounds, checkRounds, seededRng, pairKey } from '../netlify/functions/lib/rematch-draw.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `t${i + 1}`);

test('drawRounds is a complete round-robin for even and odd counts', () => {
  for (const n of [4, 5, 6, 7, 8, 9]) {
    for (let seed = 1; seed <= 40; seed++) {
      const rounds = drawRounds(ids(n), { rng: seededRng(seed) });
      assert.equal(checkRounds(rounds, ids(n)), null, `n=${n} seed=${seed}`);
      assert.equal(rounds.length, n % 2 ? n : n - 1);
    }
  }
});

test('odd count: one bye a week, every team sits exactly once', () => {
  const rounds = drawRounds(ids(5), { rng: seededRng(7) });
  assert.equal(rounds.length, 5);
  for (const r of rounds) assert.equal(r.pairs.length, 2);
  assert.deepEqual(rounds.map(r => r.bye).sort(), ids(5));
});

test('even count: no byes', () => {
  const rounds = drawRounds(ids(6), { rng: seededRng(7) });
  assert.ok(rounds.every(r => r.bye === null && r.pairs.length === 3));
});

test('same seed → same draw; different seeds differ', () => {
  const a = drawRounds(ids(5), { rng: seededRng(482380) });
  const b = drawRounds(ids(5), { rng: seededRng(482380) });
  assert.deepEqual(a, b);
  const others = new Set();
  for (let s = 1; s <= 30; s++) others.add(JSON.stringify(drawRounds(ids(5), { rng: seededRng(s) })));
  assert.ok(others.size > 10);
});

test('avoidFirst keeps last week\'s matchups out of the first new week', () => {
  const avoid = [['t1', 't2'], ['t4', 't5']];
  const keys = new Set(avoid.map(([a, b]) => pairKey(a, b)));
  for (let seed = 1; seed <= 200; seed++) {
    const rounds = drawRounds(ids(5), { rng: seededRng(seed), avoidFirst: avoid });
    assert.ok(!rounds[0].pairs.some(([a, b]) => keys.has(pairKey(a, b))), `seed ${seed}`);
    assert.equal(checkRounds(rounds, ids(5)), null);
  }
});

test('checkRounds rejects broken plans', () => {
  const good = drawRounds(ids(5), { rng: seededRng(3) });
  assert.equal(checkRounds(good, ids(5)), null);
  assert.match(checkRounds(good.slice(0, 4), ids(5)), /expected 5 weeks/);
  const noBye = good.map((r, i) => (i === 0 ? { ...r, bye: null } : r));
  assert.match(checkRounds(noBye, ids(5)), /no bye/);
  const dup = good.map((r, i) => (i === 1 ? good[0] : r));
  assert.match(checkRounds(dup, ids(5)), /already play each other/);
  const stranger = good.map((r, i) => (i === 0 ? { ...r, bye: 'nobody' } : r));
  assert.match(checkRounds(stranger, ids(5)), /unknown team/);
});
