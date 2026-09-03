import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWeekDates, weekDatesFor } from '../netlify/functions/lib/week-dates.js';

const JUL13 = '2026-07-14T02:00:00.000Z';
const OCT21 = '2026-10-22T02:00:00.000Z';

test('legacy flat map is attributed to the season the settings name', () => {
  const flat = { 5: JUL13, 6: '2026-07-21T02:00:00.000Z' };
  assert.deepEqual(normalizeWeekDates(flat, 'Season 1'), {
    I: { 5: JUL13, 6: '2026-07-21T02:00:00.000Z' },
  });
});

test('THE BUG: Season 1 planned dates never reach Season 2', () => {
  // Exactly what production held: a flat map written during Season 1.
  const stored = { 5: JUL13, 6: '2026-07-21T02:00:00.000Z', 7: '2026-07-28T02:00:00.000Z', 8: '2026-08-11T02:00:00.000Z' };
  assert.deepEqual(weekDatesFor(stored, 'season-2', 'Season 1'), {});
  assert.equal(weekDatesFor(stored, 'season-1', 'Season 1')[5], JUL13);
});

test('season keys are canonicalized, so any spelling finds its bucket', () => {
  const stored = { 'season-2': { 3: OCT21 } };
  for (const spelling of ['season-2', 'circuit-ii', 'II', 'Season 2', 2]) {
    assert.equal(weekDatesFor(stored, spelling)[3], OCT21, `lookup by ${spelling}`);
  }
  assert.deepEqual(Object.keys(normalizeWeekDates(stored)), ['II']);
});

test('buckets that resolve to the same code merge instead of clobbering', () => {
  const stored = { 'season-1': { 5: JUL13 }, 'circuit-i': { 6: OCT21 } };
  assert.deepEqual(normalizeWeekDates(stored), { I: { 5: JUL13, 6: OCT21 } });
});

test('already-normalized data round-trips unchanged', () => {
  const good = { I: { 5: JUL13 }, II: { 3: OCT21 } };
  assert.deepEqual(normalizeWeekDates(good), good);
  assert.deepEqual(normalizeWeekDates(normalizeWeekDates(good)), good);
});

test('junk is dropped rather than stored', () => {
  assert.deepEqual(normalizeWeekDates(null), {});
  assert.deepEqual(normalizeWeekDates({}), {});
  assert.deepEqual(normalizeWeekDates({ II: {} }), {});
  assert.deepEqual(normalizeWeekDates({ II: { notaweek: JUL13, 3: '', 4: null, 5: OCT21 } }), { II: { 5: OCT21 } });
  assert.deepEqual(weekDatesFor(undefined, 'season-2'), {});
});
