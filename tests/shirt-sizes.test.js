// tests/shirt-sizes.test.js
// Shirt sizes feed a real order, so bad input must never become a size and the
// order sheet must count each person exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSize, cleanCut, sizeKey, lookupSize, tally, SIZES } from '../netlify/functions/lib/shirt-sizes.js';

test('sizes normalize, junk is rejected', () => {
  assert.equal(cleanSize(' xl '), 'XL');
  assert.equal(cleanSize('xxl'), '2XL');
  assert.equal(cleanSize('XXXL'), '3XL');
  assert.equal(cleanSize('medium'), null);
  assert.equal(cleanSize('<b>M</b>'), null);
  assert.equal(cleanSize(''), null);
});

test('cuts normalize', () => {
  assert.equal(cleanCut("Women's"), 'womens');
  assert.equal(cleanCut('unisex'), 'unisex');
  assert.equal(cleanCut('mens'), 'unisex');
  assert.equal(cleanCut('kids'), null);
});

test('a person is keyed by email so the size follows them across seasons', () => {
  const k = sizeKey({ email: ' Sam@Example.com ', playerId: 'p_new' });
  assert.equal(k, sizeKey({ email: 'sam@example.com', playerId: 'p_old' }));
  assert.equal(sizeKey({ playerId: 'p_1' }), 'id:p_1');
  assert.equal(sizeKey({}), null);
});

test('lookup finds the email record first, then the id fallback', () => {
  const all = { [sizeKey({ email: 'sam@example.com' })]: { size: 'L', cut: 'unisex' }, 'id:p_9': { size: 'S', cut: 'womens' } };
  assert.equal(lookupSize(all, { email: 'SAM@example.com', playerId: 'zzz' }).size, 'L');
  assert.equal(lookupSize(all, { email: null, playerId: 'p_9' }).size, 'S');
  assert.equal(lookupSize(all, { email: 'nobody@example.com', playerId: 'p_0' }), null);
});

test('the order sheet counts by cut and size, and counts who is missing', () => {
  const t = tally([{ size: 'M', cut: 'unisex' }, { size: 'M', cut: 'unisex' }, { size: 'S', cut: 'womens' }, { size: 'L', cut: null }, { size: null }, {}]);
  assert.equal(t.counts.unisex.M, 2); assert.equal(t.counts.unisex.L, 1); assert.equal(t.counts.womens.S, 1);
  assert.deepEqual([t.have, t.missing, t.total], [4, 2, 6]);
  assert.equal(Object.keys(t.counts.unisex).length, SIZES.length);
});
