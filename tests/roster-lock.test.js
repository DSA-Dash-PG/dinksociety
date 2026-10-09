// tests/roster-lock.test.js
// When a roster locks (pure parts). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rosterLockWeek, weekPlayedFor } from '../netlify/functions/lib/roster-lock.js';

const m = (a, b, final) => ({ teamA: { id: a }, teamB: { id: b }, finalizedAt: final ? '2026-11-06T04:00:00Z' : null });

test('lock week: Season 2 is Week 8, everything else Week 2', () => {
  assert.equal(rosterLockWeek('II'), 8);
  assert.equal(rosterLockWeek('circuit-ii'), 8);
  assert.equal(rosterLockWeek('I'), 2);
  assert.equal(rosterLockWeek('III'), 2);
  assert.equal(rosterLockWeek(undefined), 2);
});

test('a team with a match that week locks when ITS match is final', () => {
  const week = { matches: [m('a', 'b', true), m('c', 'd', false)] };
  assert.equal(weekPlayedFor(week, 'a'), true);
  assert.equal(weekPlayedFor(week, 'b'), true);
  assert.equal(weekPlayedFor(week, 'c'), false);
});

test('a team on a bye (or already done) locks when the whole week is final', () => {
  assert.equal(weekPlayedFor({ matches: [m('a', 'b', true), m('c', 'd', false)] }, 'bye'), false);
  assert.equal(weekPlayedFor({ matches: [m('a', 'b', true), m('c', 'd', true)] }, 'bye'), true);
});

test('no week, an empty week, or unseeded bracket placeholders never lock', () => {
  assert.equal(weekPlayedFor(null, 'a'), false);
  assert.equal(weekPlayedFor({ matches: [] }, 'a'), false);
  const placeholders = { matches: [{ teamA: null, teamB: null, phase: 'championship' }, { teamA: null, teamB: null, phase: 'championship' }] };
  assert.equal(weekPlayedFor(placeholders, 'a'), false);
});
