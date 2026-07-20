// tests/lineup-notify.test.js
// The per-player diff that decides who gets a "your lineup changed" email.
// Getting this wrong either spams the whole team on every re-lock, or silently
// fails to tell someone they've been dropped — so it's worth pinning down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { byPlayer, diffForPlayer } from '../netlify/functions/lib/lineup-notify.js';
import { gameNoOf } from '../netlify/functions/lib/lineup-helpers.js';

const NAMES = { kayo: 'Kayo Hayashi', arica: 'Arica Green', yoshi: 'Yoshi Nogimura', fiat: 'Fiat Tapaneeyakorn', rich: 'Richard Hak' };
const nameOf = (id) => (id ? NAMES[id] || null : null);

// Round 1 g1 + g4, Round 2 g4  →  display Games 1, 4, 10
const baseGames = {
  r1g1: { p1: 'kayo', p2: 'arica' },
  r1g4: { p1: 'kayo', p2: 'yoshi' },
  r2g4: { p1: 'kayo', p2: 'rich' },
};

const diffFor = (id, prev, next) =>
  diffForPlayer(byPlayer(prev).get(id), byPlayer(next).get(id), nameOf);

test('byPlayer indexes both seats and sorts by display game number', () => {
  const map = byPlayer(baseGames);
  assert.deepEqual(map.get('kayo').map(g => g.no), [1, 4, 10]);
  assert.deepEqual(map.get('arica').map(g => g.no), [1]);
  // partner is the other seat, whichever side the player sits on
  assert.equal(map.get('arica')[0].partnerId, 'kayo');
  assert.equal(map.get('kayo')[0].partnerId, 'arica');
});

test('round 2 games carry display numbers 7-12', () => {
  assert.equal(gameNoOf('r2g4'), 10);
  assert.equal(byPlayer({ r2g6: { p1: 'kayo', p2: 'rich' } }).get('kayo')[0].no, 12);
});

test('no change produces no diff — a re-lock with no edit stays silent', () => {
  assert.deepEqual(diffFor('kayo', baseGames, baseGames), []);
  assert.deepEqual(diffFor('arica', baseGames, baseGames), []);
});

test('partner swap is reported to the player who kept the slot', () => {
  const next = { ...baseGames, r1g4: { p1: 'kayo', p2: 'fiat' } };
  const d = diffFor('kayo', baseGames, next);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0], { kind: 'partner', no: 4, typeLabel: 'Mixed', partner: 'Fiat Tapaneeyakorn', wasPartner: 'Yoshi Nogimura' });
});

test('the dropped partner sees a drop, the new partner sees an add', () => {
  const next = { ...baseGames, r1g4: { p1: 'kayo', p2: 'fiat' } };
  assert.deepEqual(diffFor('yoshi', baseGames, next), [{ kind: 'dropped', no: 4, typeLabel: 'Mixed' }]);
  assert.deepEqual(diffFor('fiat', baseGames, next), [{ kind: 'added', no: 4, typeLabel: 'Mixed', partner: 'Kayo Hayashi' }]);
});

test('a player removed from every game gets drops for all of them, in game order', () => {
  const next = { r1g1: { p1: 'arica', p2: 'fiat' } };
  const d = diffFor('kayo', baseGames, next);
  assert.deepEqual(d.map(c => [c.kind, c.no]), [['dropped', 1], ['dropped', 4], ['dropped', 10]]);
});

test('changes are sorted by display number, not slot key order', () => {
  const next = { r1g1: { p1: 'kayo', p2: 'arica' }, r2g6: { p1: 'kayo', p2: 'fiat' } };
  const d = diffFor('kayo', baseGames, next);
  const nos = d.map(c => c.no);
  assert.deepEqual(nos, [...nos].sort((a, b) => a - b));
  assert.ok(nos.includes(12), 'round-2 game shows as 12');
});

test('an unaffected teammate is not notified when someone else is swapped', () => {
  const next = { ...baseGames, r2g4: { p1: 'kayo', p2: 'fiat' } };
  assert.deepEqual(diffFor('arica', baseGames, next), [], 'Arica keeps Game 1 untouched');
});

test('first send has no prior snapshot — every game reads as added', () => {
  const d = diffForPlayer(undefined, byPlayer(baseGames).get('kayo'), nameOf);
  assert.deepEqual(d.map(c => c.kind), ['added', 'added', 'added']);
});

test('an empty seat does not invent a partner', () => {
  const prev = { r1g1: { p1: 'kayo', p2: null } };
  const next = { r1g1: { p1: 'kayo', p2: 'arica' } };
  const d = diffFor('kayo', prev, next);
  // Note the typographic apostrophe — it comes from slotTypeLabel(), not this test.
  assert.deepEqual(d, [{ kind: 'partner', no: 1, typeLabel: 'Women’s', partner: 'Arica Green', wasPartner: null }]);
});
