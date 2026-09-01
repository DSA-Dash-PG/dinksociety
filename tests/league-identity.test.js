// tests/league-identity.test.js
// The identity grouping is what lets one human keep her stats across teams and
// seasons, so the rules get pinned down here: email joins, an admin split peels
// someone off a shared inbox, an admin link joins ids that share nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupEntries, mergeStatRows, pairKey, resolveLink } from '../netlify/functions/lib/league-identity.js';

const e = (id, email, extra = {}) => ({ id, email, ...extra });

// Members of the group `id` belongs to, sorted — the shape assertions care about.
function membersFor(res, id) {
  const canon = res.canonicalOf[id];
  return (res.membersOf[canon] || []).slice().sort();
}

test('same email joins entries across teams and seasons', () => {
  const res = groupEntries([
    e('p_old_0', 'Jane@Example.com ', { circuit: 'I', teamId: 't1' }),
    e('p_new_0', 'jane@example.com',  { circuit: 'II', teamId: 't2' }),
    e('p_other_0', 'bob@example.com', { circuit: 'II', teamId: 't2' }),
  ]);
  assert.deepEqual(membersFor(res, 'p_old_0'), ['p_new_0', 'p_old_0']);
  assert.deepEqual(membersFor(res, 'p_other_0'), ['p_other_0']);
});

test('the newest season supplies the canonical id', () => {
  const res = groupEntries([
    e('z_old', 'jane@example.com', { circuit: 'I' }),
    e('a_new', 'jane@example.com', { circuit: 'II' }),
  ]);
  // 'a_new' would also win alphabetically, so use a case where they disagree.
  const res2 = groupEntries([
    e('a_old', 'jane@example.com', { circuit: 'I' }),
    e('z_new', 'jane@example.com', { circuit: 'II' }),
  ]);
  assert.equal(res.canonicalOf['z_old'], 'a_new');
  assert.equal(res2.canonicalOf['a_old'], 'z_new', 'newest season wins over alphabetical order');
});

test('entries without an email never join anyone', () => {
  const res = groupEntries([
    e('p1', ''), e('p2', null), e('p3', 'not-an-email'),
  ]);
  assert.deepEqual(membersFor(res, 'p1'), ['p1']);
  assert.deepEqual(membersFor(res, 'p2'), ['p2']);
  assert.deepEqual(membersFor(res, 'p3'), ['p3']);
});

test('an admin split separates two people sharing one inbox', () => {
  const entries = [
    e('husband', 'family@example.com', { circuit: 'II' }),
    e('wife',    'family@example.com', { circuit: 'II' }),
  ];
  const joined = groupEntries(entries);
  assert.equal(membersFor(joined, 'husband').length, 2);

  const split = groupEntries(entries, { splits: { [pairKey('husband', 'wife')]: true } });
  assert.deepEqual(membersFor(split, 'husband'), ['husband']);
  assert.deepEqual(membersFor(split, 'wife'), ['wife']);
});

test('a split peels one person out of a shared inbox, keeping the rest joined', () => {
  const entries = [
    e('jane_s1', 'family@example.com', { circuit: 'I' }),
    e('jane_s2', 'family@example.com', { circuit: 'II' }),
    e('spouse',  'family@example.com', { circuit: 'II' }),
  ];
  const res = groupEntries(entries, { splits: {
    [pairKey('jane_s1', 'spouse')]: true,
    [pairKey('jane_s2', 'spouse')]: true,
  } });
  assert.deepEqual(membersFor(res, 'jane_s1'), ['jane_s1', 'jane_s2']);
  assert.deepEqual(membersFor(res, 'spouse'), ['spouse']);
});

test('an admin link joins ids with different emails (married name, typo)', () => {
  const res = groupEntries([
    e('maiden', 'jane.smith@example.com', { circuit: 'I' }),
    e('married', 'jane.jones@example.com', { circuit: 'II' }),
  ], { links: { maiden: { to: 'married' } } });
  assert.deepEqual(membersFor(res, 'maiden'), ['maiden', 'married']);
});

test('link chains resolve to the end without looping forever', () => {
  const links = { a: { to: 'b' }, b: { to: 'c' } };
  assert.equal(resolveLink(links, 'a'), 'c');
  const loop = { a: { to: 'b' }, b: { to: 'a' } };
  assert.ok(['a', 'b'].includes(resolveLink(loop, 'a')));
});

test('pairKey is order-independent', () => {
  assert.equal(pairKey('b', 'a'), pairKey('a', 'b'));
});

test('mergeStatRows adds counting stats and keeps DSR from the busier entry', () => {
  const merged = mergeStatRows([
    { __id: 'a', name: 'Jane', teamId: 't1', teamName: 'Old', gamesWon: 10, gamesLost: 2, gamesPlayed: 12,
      matchesPlayed: 6, ps: 300, pa: 200, composite: 500,
      byType: { mixed: { won: 6, lost: 1 } }, partners: { x: { played: 4, won: 3 } }, awards: ['mvp'] },
    { __id: 'b', name: 'Jane', teamId: 't2', teamName: 'New', gamesWon: 3, gamesLost: 1, gamesPlayed: 4,
      matchesPlayed: 2, ps: 90, pa: 70, composite: 600,
      byType: { mixed: { won: 2, lost: 1 }, womens: { won: 1, lost: 0 } }, partners: { x: { played: 1, won: 1 }, y: { played: 1, won: 0 } }, awards: [] },
  ], 'b');

  assert.equal(merged.gamesWon, 13);
  assert.equal(merged.gamesLost, 3);
  assert.equal(merged.matchesPlayed, 8);
  assert.equal(merged.ps, 390);
  assert.equal(merged.diff, 120, 'diff recomputed from merged ps/pa, never summed');
  assert.equal(merged.composite, 500, 'DSR comes from the entry with the most games, not a sum');
  assert.equal(merged.teamName, 'New', 'identity fields follow the id that was requested');
  assert.deepEqual(merged.byType.mixed, { won: 8, lost: 2 });
  assert.deepEqual(merged.byType.womens, { won: 1, lost: 0 });
  assert.deepEqual(merged.partners.x, { played: 5, won: 4 });
  assert.deepEqual(merged.partners.y, { played: 1, won: 0 });
  assert.deepEqual(merged.awards, ['mvp']);
  assert.equal(merged.teams.length, 2);
});

test('mergeStatRows passes a single row through and handles none', () => {
  assert.equal(mergeStatRows([], 'a'), null);
  assert.equal(mergeStatRows([null], 'a'), null);
  const one = mergeStatRows([{ __id: 'a', gamesWon: 4 }], 'a');
  assert.equal(one.gamesWon, 4);
});
