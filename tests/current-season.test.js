// tests/current-season.test.js
// The season flip decides what the whole public site points at, and it happens
// unattended on a date months from now — so the rule is pinned down here rather
// than discovered on opening night.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickCurrentSeason, currentSeasonInfo, flipMs, startMs, FLIP_LEAD_DAYS,
} from '../netlify/functions/lib/current-season.js';

const S1 = { id: 'circuit-i',  name: 'Season 1', startDate: '2026-06-08' };
const S2 = { id: 'circuit-2',  name: 'Season 2', startDate: '2026-09-24' };
const S3 = { id: 'circuit-3',  name: 'Season 3', startDate: '2027-01-12' };
const at = iso => new Date(iso).getTime();

test('a season takes over exactly one week before it starts', () => {
  assert.equal(FLIP_LEAD_DAYS, 7);
  const flip = new Date(flipMs(S2)).toISOString().slice(0, 10);
  assert.equal(flip, '2026-09-17', 'Sep 24 start → Sep 17 flip');
});

test('Season 1 stays live right up to the flip moment', () => {
  const seasons = [S1, S2];
  assert.equal(pickCurrentSeason(seasons, at('2026-09-01T12:00:00Z')).id, 'circuit-i');
  assert.equal(pickCurrentSeason(seasons, at('2026-09-16T23:59:59Z')).id, 'circuit-i', 'the day before');
});

test('Season 2 takes over on the flip date and stays through its run', () => {
  const seasons = [S1, S2];
  assert.equal(pickCurrentSeason(seasons, at('2026-09-17T00:00:00Z')).id, 'circuit-2', 'the moment it flips');
  assert.equal(pickCurrentSeason(seasons, at('2026-09-24T19:00:00Z')).id, 'circuit-2', 'opening night');
  assert.equal(pickCurrentSeason(seasons, at('2026-11-30T00:00:00Z')).id, 'circuit-2', 'long after it started');
});

test('the newest flipped season wins, so an old one steps down on the same date', () => {
  const seasons = [S1, S2, S3];
  assert.equal(pickCurrentSeason(seasons, at('2027-01-04T00:00:00Z')).id, 'circuit-2', 'Season 3 has not flipped');
  assert.equal(pickCurrentSeason(seasons, at('2027-01-05T00:00:00Z')).id, 'circuit-3', 'Season 3 flips, Season 2 steps down');
});

test('list order does not decide it', () => {
  const now = at('2026-10-01T00:00:00Z');
  assert.equal(pickCurrentSeason([S1, S2], now).id, 'circuit-2');
  assert.equal(pickCurrentSeason([S2, S1], now).id, 'circuit-2', 'same answer reversed');
});

test('before anything has flipped, the soonest upcoming season leads', () => {
  assert.equal(pickCurrentSeason([S2, S3], at('2026-01-01T00:00:00Z')).id, 'circuit-2');
});

test('seasons with no start date fall back to the list, never to a crash', () => {
  assert.equal(pickCurrentSeason([{ id: 'x', name: 'Undated' }], Date.now()).id, 'x');
  // A dated season still beats an undated one.
  assert.equal(pickCurrentSeason([{ id: 'x' }, S1], at('2026-07-01T00:00:00Z')).id, 'circuit-i');
  assert.equal(pickCurrentSeason([], Date.now()), null);
  assert.equal(pickCurrentSeason(null, Date.now()), null);
  assert.equal(startMs({ startDate: 'not-a-date' }), null);
  assert.equal(flipMs({}), null);
});

test('currentSeasonInfo reports the live season and when the next one lands', () => {
  const info = currentSeasonInfo([S1, S2], at('2026-09-01T00:00:00Z'));
  assert.equal(info.id, 'circuit-i');
  assert.equal(info.circuit, 'I', 'the code the blobs are keyed by');
  assert.equal(info.name, 'Season 1');
  assert.equal(info.nextFlipsAt.slice(0, 10), '2026-09-17');
  assert.equal(info.nextName, 'Season 2');

  const after = currentSeasonInfo([S1, S2], at('2026-09-20T00:00:00Z'));
  assert.equal(after.id, 'circuit-2');
  assert.equal(after.circuit, 'II');
  assert.equal(after.nextFlipsAt, null, 'nothing queued behind it');
});

test('the code is resolved even when the id is a slug', () => {
  const info = currentSeasonInfo([{ id: 'fall-2026', name: 'Season 2', startDate: '2026-09-24' }], at('2026-10-01T00:00:00Z'));
  assert.equal(info.circuit, 'II');
});
