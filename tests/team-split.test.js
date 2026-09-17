// tests/team-split.test.js
// The captain fee split is money between teammates, so the sums have to be
// exact: shares add back up to the cent, the captain never eats a rounding
// penny, and a player only ever sees their own row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toCents, fmtCents, normalizeHandle, splitEvenly, flatShares, countGames, buildLedger, playerView,
} from '../netlify/functions/lib/team-split-math.js';
import { SLOT_KEYS } from '../netlify/functions/lib/score-helpers.js';

const sum = (o) => Object.values(o).reduce((s, n) => s + n, 0);

test('dollars parse to exact cents — no float drift', () => {
  assert.equal(toCents('700'), 70000);
  assert.equal(toCents('$4.25'), 425);
  assert.equal(toCents('0.1'), 10);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('1,250.50'), 125050);
  assert.equal(toCents('4.255'), null);
  assert.equal(toCents('-5'), null);
  assert.equal(toCents('abc'), null);
  assert.equal(toCents(''), null);
});

test('cents format with two decimals unless a whole dollar', () => {
  assert.equal(fmtCents(7000), '$70');
  assert.equal(fmtCents(7778), '$77.78');
  assert.equal(fmtCents(850), '$8.50');
  assert.equal(fmtCents(125050), '$1,250.50');
  assert.equal(fmtCents(-425), '-$4.25');
});

test('venmo handles are cleaned or rejected', () => {
  assert.equal(normalizeHandle('@Net-Gains_Cap '), 'Net-Gains_Cap');
  assert.equal(normalizeHandle('bad handle'), null);
  assert.equal(normalizeHandle('<script>'), null);
  assert.equal(normalizeHandle(''), null);
});

test('$700 across 9 splits to the cent and adds back up exactly', () => {
  const ids = 'abcdefghi'.split('');
  const s = splitEvenly(70000, ids);
  assert.equal(sum(s), 70000);
  assert.deepEqual([...new Set(Object.values(s))].sort(), [7777, 7778]);
  assert.equal(Object.values(s).filter(v => v === 7778).length, 7);
});

test('the captain is a share, and never picks up the rounding penny', () => {
  const ids = ['cap', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const { shares, unassignedCents } = flatShares({ amountCents: 70000, playerIds: ids, payeeId: 'cap' });
  assert.equal(sum(shares), 70000);
  assert.equal(shares.cap, 7777);
  assert.equal(unassignedCents, 0);
});

test('an override pins one player and the rest share what is left', () => {
  const ids = ['cap', 'b', 'c', 'sub'];
  const { shares } = flatShares({ amountCents: 70000, playerIds: ids, overrides: { sub: 3500 }, payeeId: 'cap' });
  assert.equal(shares.sub, 3500);
  assert.equal(sum(shares), 70000);
  assert.equal(shares.b, 22167); assert.equal(shares.c, 22167); assert.equal(shares.cap, 22166);
  // $0 override = excluded from the split
  const z = flatShares({ amountCents: 9000, playerIds: ['a', 'b', 'c'], overrides: { c: 0 } }).shares;
  assert.deepEqual(z, { c: 0, a: 4500, b: 4500 });
});

test('everyone overridden and short → the gap is reported, not hidden', () => {
  const r = flatShares({ amountCents: 10000, playerIds: ['a', 'b'], overrides: { a: 4000, b: 4000 } });
  assert.equal(r.unassignedCents, 2000);
});

function scoreWith(played) {
  const games = {};
  for (const slot of SLOT_KEYS) {
    games[slot] = played.includes(slot)
      ? { home: 11, away: 7, homeEntry: { home: 11, away: 7 }, awayEntry: { home: 11, away: 7 } }
      : { home: null, away: null, homeEntry: null, awayEntry: null };
  }
  return { games };
}

test('per game only counts slots with an agreed score', () => {
  const lineup = { games: { r1g1: { p1: 'a', p2: 'b' }, r1g2: { p1: 'a', p2: 'c' }, r1g3: { p1: 'b', p2: 'c' } } };
  const counts = countGames({ lineup, score: scoreWith(['r1g1', 'r1g2']) });
  assert.deepEqual(counts, { a: 2, b: 1, c: 1 });
  assert.deepEqual(countGames({ lineup: null, score: scoreWith(['r1g1']) }), {});
});

const team = {
  id: 't1', captainEmail: 'cap@x.com',
  roster: [
    { id: 'cap', name: 'Jordan', email: 'cap@x.com', isCaptain: true },
    { id: 'p1', name: 'Alana', email: 'a@x.com' },
    { id: 'p2', name: 'Priya', email: 'p@x.com' },
    { id: 'gone', name: 'Left Team', archived: true },
    { id: 'wait', name: 'Pending', pendingAdd: true },
  ],
};

test('flat ledger: captain self-covered, payments and claims drive status', () => {
  const split = { mode: 'flat', amountCents: 21000, payments: { p1: [{ id: 'x', cents: 7000 }] }, claims: { p2: { cents: 7000, at: 'now' } } };
  const L = buildLedger({ split, team });
  assert.equal(L.rows.length, 3); // archived + pending are not in a live flat split
  const by = Object.fromEntries(L.rows.map(r => [r.playerId, r]));
  assert.equal(by.cap.status, 'self'); assert.equal(by.cap.balanceCents, 0);
  assert.equal(by.p1.status, 'paid');
  assert.equal(by.p2.status, 'claim'); assert.equal(by.p2.balanceCents, 7000);
  assert.deepEqual(L.totals, { totalCents: 21000, outstandingCents: 7000, collectedCents: 14000, gamesBilled: 0, claims: 1, owing: 1 });
});

test('a locked flat split keeps billing a player who later left', () => {
  const split = { mode: 'flat', amountCents: 40000, lockedPlayerIds: ['cap', 'p1', 'p2', 'gone'] };
  const L = buildLedger({ split, team });
  assert.equal(L.rows.find(r => r.playerId === 'gone').owedCents, 10000);
});

test('per game ledger: rate x games, all weeks, partial payment leaves a balance', () => {
  const split = { mode: 'pergame', rateCents: 425, payments: { p2: [{ id: 'y', cents: 2550 }] } };
  const tabs = [
    { matchId: 'm1', week: 1, counts: { cap: 3, p1: 3, p2: 3 } },
    { matchId: 'm2', week: 2, counts: { cap: 3, p2: 3, gone: 2 } },
    { matchId: 'm8', week: 8, phase: 'playoff', counts: { p2: 2 } },
  ];
  const L = buildLedger({ split, team, tabs });
  const by = Object.fromEntries(L.rows.map(r => [r.playerId, r]));
  assert.equal(by.p2.games, 8); assert.equal(by.p2.owedCents, 3400); assert.equal(by.p2.balanceCents, 850);
  assert.equal(by.p2.weeks.length, 3);
  assert.equal(by.gone.owedCents, 850);          // archived but played → still owes
  assert.equal(by.p1.owedCents, 1275);
  assert.equal(L.totals.gamesBilled, 19);
  assert.equal(L.totals.totalCents, 19 * 425);
});

test('a player view is their own row only — no teammates, no totals', () => {
  const split = { mode: 'flat', amountCents: 21000, payments: { p1: [{ id: 'x', cents: 7000, by: 'cap@x.com', note: 'secret', at: 't', method: 'venmo' }] } };
  const v = playerView(buildLedger({ split, team }), 'p1');
  assert.equal(v.owedCents, 7000); assert.equal(v.balanceCents, 0);
  const flat = JSON.stringify(v);
  assert.ok(!flat.includes('Priya') && !flat.includes('totals') && !flat.includes('secret') && !flat.includes('cap@x.com'));
  assert.equal(playerView(buildLedger({ split, team }), 'nobody'), null);
});
