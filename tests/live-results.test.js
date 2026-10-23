// node --test tests/live-results.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSuspended, frozenSlots, effectiveStart, matchStarted, confirmedSlots,
  countState, lineupSlotVisible, publicSuspension, roundsComplete,
} from '../netlify/functions/lib/live-results.js';

const game = (h, a) => ({ home: h, away: a, homeEntry: { home: h, away: a }, awayEntry: { home: h, away: a } });
const partial = (h, a) => ({ home: null, away: null, homeEntry: { home: h, away: a }, awayEntry: null });

function scoreWith(confirmed = {}, unconfirmed = {}) {
  const games = {};
  for (const [s, [h, a]] of Object.entries(confirmed)) games[s] = game(h, a);
  for (const [s, [h, a]] of Object.entries(unconfirmed)) games[s] = partial(h, a);
  return { games };
}

const PAST = '2026-10-22T01:00:00.000Z';
const FUTURE = '2026-10-29T00:00:00.000Z';

test('a suspension only counts while the match is not final', () => {
  const m = { scheduledAt: PAST, suspended: { resumeAt: FUTURE, lockedSlots: ['r1g1'] } };
  assert.equal(isSuspended(m), true);
  assert.equal(isSuspended({ ...m, finalizedAt: PAST }), false);
  assert.equal(isSuspended({ scheduledAt: PAST }), false);
});

test('frozen slots are a Set of valid slot keys', () => {
  const m = { scheduledAt: PAST, suspended: { resumeAt: FUTURE, lockedSlots: ['r1g1', 'r1g2', 'bogus'] } };
  assert.deepEqual([...frozenSlots(m)], ['r1g1', 'r1g2']);
  assert.equal(frozenSlots({ scheduledAt: PAST }).size, 0);
});

test('the lock/reveal clock moves to the resume time while suspended', () => {
  const m = { scheduledAt: PAST, suspended: { resumeAt: FUTURE, lockedSlots: [] } };
  assert.equal(effectiveStart(m), FUTURE);
  assert.equal(effectiveStart({ scheduledAt: PAST }), PAST);
  assert.equal(effectiveStart({ ...m, finalizedAt: PAST }), PAST);
  assert.equal(matchStarted(m, Date.parse('2026-10-23T00:00:00Z')), true);
});

test('confirmed slots and complete rounds', () => {
  const r1 = { r1g1: [11, 3], r1g2: [11, 9], r1g3: [5, 11], r1g4: [11, 7], r1g5: [11, 2], r1g6: [8, 11] };
  const sc = scoreWith({ ...r1, r2g1: [11, 4] }, { r2g2: [11, 6] });
  assert.equal(confirmedSlots(sc).size, 7);
  assert.equal(roundsComplete(sc), 1);
});

test('countState: final, live (started + a confirmed game), else nothing', () => {
  const now = Date.parse('2026-10-23T00:00:00Z');
  const started = { scheduledAt: PAST };
  assert.equal(countState({ ...started, finalizedAt: PAST }, null, now), 'final');
  assert.equal(countState(started, scoreWith({ r1g1: [11, 3] }), now), 'live');
  assert.equal(countState(started, scoreWith({}, { r1g1: [11, 3] }), now), null, 'an unconfirmed entry is not a result');
  assert.equal(countState({ scheduledAt: FUTURE }, scoreWith({ r1g1: [11, 3] }), now), null, 'not started');
  assert.equal(countState(started, null, now), null);
});

test('lineup visibility: everything once revealed, only frozen games before', () => {
  const m = { scheduledAt: PAST, suspended: { resumeAt: FUTURE, lockedSlots: ['r1g1', 'r1g2'] } };
  const hidden = lineupSlotVisible(m, false);
  assert.equal(hidden('r1g1'), true);
  assert.equal(hidden('r2g1'), false);
  const shown = lineupSlotVisible(m, true);
  assert.equal(shown('r2g1'), true);
  assert.equal(lineupSlotVisible({ scheduledAt: PAST }, false)('r1g1'), false);
});

test('publicSuspension is PII-free and counts the remainder', () => {
  const m = { scheduledAt: PAST, suspended: { at: PAST, by: 'admin@x', resumeAt: FUTURE, lockedSlots: ['r1g1', 'r1g2', 'r1g3'], note: 'Courts 5 & 6' } };
  const p = publicSuspension(m);
  assert.equal(p.lockedCount, 3);
  assert.equal(p.remaining, 9);
  assert.equal(p.resumeAt, FUTURE);
  assert.equal(p.note, 'Courts 5 & 6');
  assert.equal('by' in p, false);
  assert.equal(publicSuspension({ ...m, finalizedAt: PAST }), null);
});
