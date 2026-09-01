// tests/circuit.test.js
// Season codes key every schedule, standings and player-stats blob, so the
// mapping from a season record to its code has to survive ids that don't look
// like "circuit-1". Getting this wrong listed one season twice on the
// leaderboard — once under a code with no data, once under the code with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circuitCode, seasonCircuitCode, isCanonicalCode, seasonIdForCircuit, seasonName } from '../netlify/functions/lib/circuit.js';

test('circuitCode resolves the shapes it always has', () => {
  assert.equal(circuitCode('Season 1'), 'I');
  assert.equal(circuitCode('circuit-i'), 'I');
  assert.equal(circuitCode('circuit-1'), 'I');
  assert.equal(circuitCode('I'), 'I');
  assert.equal(circuitCode('circuit-test'), 'TEST');
  assert.equal(circuitCode('TEST'), 'TEST');
  assert.equal(circuitCode(undefined), 'I');
  assert.equal(circuitCode('Season 2'), 'II');
});

test('isCanonicalCode knows a usable code from a leftover token', () => {
  assert.ok(isCanonicalCode('I'));
  assert.ok(isCanonicalCode('ii'));
  assert.ok(isCanonicalCode('TEST'));
  assert.ok(!isCanonicalCode('SEASON-1'));
  assert.ok(!isCanonicalCode('S_9F2C'));
  assert.ok(!isCanonicalCode(''));
});

test('a season falls back to its name when the id is a slug', () => {
  assert.equal(seasonCircuitCode({ id: 'circuit-i', name: 'Season 1' }), 'I');
  assert.equal(seasonCircuitCode({ id: 'season-1', name: 'Season 1' }), 'I', 'the reported bug');
  assert.equal(seasonCircuitCode({ id: 's_9f2c', name: 'Season 2' }), 'II');
  assert.equal(seasonCircuitCode({ id: 'fall-2026', label: 'Season 3 (Fall)' }), 'III', 'label counts too');
  assert.equal(seasonCircuitCode({ id: 'fall-2026', circuit: 'II' }), 'II', 'an explicit code wins');
  // A bare roman-looking id is taken at face value — 'x' really is season ten.
  assert.equal(seasonCircuitCode({ id: 'x', name: 'Season 3' }), 'X');
});

test('the id still wins when it is already canonical', () => {
  // A mislabelled name must never drag a season off its own data.
  assert.equal(seasonCircuitCode({ id: 'circuit-2', name: 'Season 1' }), 'II');
  assert.equal(seasonCircuitCode({ id: 'circuit-test', name: 'Season 1' }), 'TEST');
});

test('nothing resolvable leaves the token alone rather than guessing', () => {
  assert.equal(seasonCircuitCode({ id: 'weird', name: 'Nonsense' }), 'WEIRD');
});

test('code and season id round-trip, and the display name follows', () => {
  assert.equal(seasonIdForCircuit('I'), 'circuit-i');
  assert.equal(seasonIdForCircuit('Season 2'), 'circuit-ii');
  assert.equal(seasonName('I'), 'Season 1');
  assert.equal(seasonName('circuit-2'), 'Season 2');
  assert.equal(seasonName('TEST'), 'Test Season');
});
