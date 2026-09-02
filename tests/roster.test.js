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

// ── The decision email ─────────────────────────────────────────────
// A request that vanishes silently is worse than no approval step: the captain
// re-adds the player and wonders why nothing sticks. These pin the two shapes.
import { renderRosterAddDecision } from '../netlify/functions/lib/email.js';

const strip = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('approval email says they are on the roster and can be played', () => {
  const html = renderRosterAddDecision({
    approved: true, playerName: 'Arica Green', teamName: 'Big Dink Energy',
    seasonName: 'Season 2', portalUrl: 'https://dinksociety.app/captain.html',
  });
  const txt = strip(html);
  assert.match(txt, /Roster approved/);
  assert.match(txt, /Arica Green is on your roster/);
  assert.match(txt, /picked for a lineup/);
  assert.match(html, /https:\/\/dinksociety\.app\/captain\.html/);
});

test('decline email explains, carries the note, and offers a way back', () => {
  const html = renderRosterAddDecision({
    approved: false, playerName: 'Jane Doe', teamName: 'Bonkerz',
    note: 'Roster is full for this division.',
    portalUrl: 'https://dinksociety.app/captain.html', adminEmail: 'dink@dinksociety.app',
  });
  const txt = strip(html);
  assert.match(txt, /declined/i);
  assert.match(txt, /Roster is full for this division\./, 'the admin note reaches the captain');
  assert.match(txt, /Think this was a mistake\?/);
  assert.match(txt, /dink@dinksociety\.app/);
});

test('an empty note leaves no empty note block behind', () => {
  const html = renderRosterAddDecision({
    approved: false, playerName: 'Jane Doe', teamName: 'Bonkerz', portalUrl: '#',
  });
  assert.equal(html.includes('border-left:3px solid'), false);
});

test('names from the roster are escaped, not injected', () => {
  const html = renderRosterAddDecision({
    approved: true, playerName: '<script>alert(1)</script>', teamName: 'T', portalUrl: '#',
  });
  assert.match(html, /&lt;script&gt;/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
});
