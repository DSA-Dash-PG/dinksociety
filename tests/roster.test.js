// tests/roster.test.js
// A captain can shape their own roster, but not put a stranger on it. These
// pin down who counts as "on the team" — the answer every lineup, availability
// nudge and public roster depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActivePlayer, activeRoster, pendingAdds } from '../netlify/functions/lib/roster.js';

const team = {
  roster: [
    { id: 'a', name: 'On the team' },
    { id: 'b', name: 'Archived', archived: true },
    { id: 'c', name: 'Awaiting approval', pendingAdd: true },
    { id: 'd', name: 'Approved after a request', approvedAt: '2026-09-01T00:00:00Z' },
  ],
};

test('a player awaiting league approval is not on the roster', () => {
  assert.equal(isActivePlayer({ id: 'x' }), true);
  assert.equal(isActivePlayer({ id: 'x', pendingAdd: true }), false);
  assert.equal(isActivePlayer({ id: 'x', archived: true }), false);
  assert.equal(isActivePlayer(null), false);
});

test('activeRoster excludes both archived and pending players', () => {
  assert.deepEqual(activeRoster(team).map(p => p.id), ['a', 'd'],
    'an approved player is a normal member; approvedAt is just provenance');
});

test('pendingAdds is exactly what the league has to rule on', () => {
  assert.deepEqual(pendingAdds(team).map(p => p.id), ['c']);
  assert.deepEqual(pendingAdds({}), []);
  assert.deepEqual(pendingAdds(null), []);
});

test('an empty or missing roster is handled, not thrown on', () => {
  assert.deepEqual(activeRoster(null), []);
  assert.deepEqual(activeRoster({}), []);
  assert.deepEqual(activeRoster({ roster: [] }), []);
});
