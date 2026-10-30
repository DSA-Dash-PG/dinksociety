// tests/skill-bands.test.js — "Performance vs. Skill Level" on player profiles.
//   node --test tests/skill-bands.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandEdges, bandOf, tagFor, summarize, readFor, rangeLabel, bestWorst, MIN_GAMES } from '../netlify/functions/lib/skill-bands.js';

// 20 rated players, DSR 30, 32, … 68 → fifths of four players each.
const RATED = Array.from({ length: 20 }, (_, i) => 30 + i * 2);

test('bandEdges: five contiguous bands spanning the league', () => {
  const e = bandEdges(RATED);
  assert.equal(e.length, 5);
  assert.equal(e[0].lo, 30);
  assert.equal(e[4].hi, 68);
  for (let i = 1; i < 5; i++) assert.equal(e[i].lo, e[i - 1].hi);
});

test('bandEdges: too few rated players or no spread → no bands', () => {
  assert.equal(bandEdges([40, 41, 42]), null);
  assert.equal(bandEdges(Array(12).fill(50)), null);
  assert.equal(bandEdges([...RATED.slice(0, 9), null, NaN]), null);
});

test('bandOf: ends clamp, boundaries go up', () => {
  const e = bandEdges(RATED);
  assert.equal(bandOf(10, e), 0);
  assert.equal(bandOf(99, e), 4);
  assert.equal(bandOf(e[1].lo, e), 1);
  assert.equal(bandOf(null, e), null);
  assert.equal(bandOf(50, null), null);
});

test('tagFor: DUPR-style verdicts, small samples get none', () => {
  assert.equal(tagFor(95, 21), 'dominant');
  assert.equal(tagFor(61, 31), 'strong');
  assert.equal(tagFor(41, 34), 'growing');
  assert.equal(tagFor(31, 36), 'challenge');
  assert.equal(tagFor(50, 38), 'competitive');
  assert.equal(tagFor(45, 20), 'competitive');
  assert.equal(tagFor(44, 25), 'growing');
  assert.equal(tagFor(29, 14), 'challenge');
  assert.equal(tagFor(100, MIN_GAMES - 1), 'sample');
});

const g = (won, oppDsr, partnerDsr) => ({ won, oppDsr, partnerDsr });

test('summarize: tallies by opponent band, skips ties and unrated', () => {
  const e = bandEdges(RATED);
  const games = [
    g(true, 31, 50), g(true, 33, 50), g(false, 34, 50),     // bottom
    g(true, 66, 60), g(false, 67, 60),                       // top
    g(null, 50, 50),                                         // tie — out
    g(true, null, 50),                                       // no opp rating — out
  ];
  const s = summarize(games, e, { myDsr: 51 });
  assert.equal(s.games, 5);
  assert.equal(s.bands.length, 5);
  assert.deepEqual([s.bands[0].w, s.bands[0].l, s.bands[0].pct], [2, 1, 67]);
  assert.equal(s.bands[0].tag, 'strong');
  assert.equal(s.bands[4].tag, 'sample');
  assert.equal(s.bands[2].played, 0);
  assert.equal(s.bands[2].tag, null);
  assert.equal(s.bands[0].partner, 50);
  assert.equal(s.you, bandOf(51, e));
  assert.equal(s.partner, 54);
});

test('summarize: career keeps each game\'s season band, no ranges', () => {
  const s = summarize([{ won: true, band: 4, oppDsr: 70 }, { won: false, band: 4 }, { won: true, band: 0 }], null);
  assert.equal(s.bands[4].played, 2);
  assert.equal(s.bands[4].lo, null);
  assert.equal(s.you, null);
});

test('summarize: nothing countable → null', () => {
  assert.equal(summarize([], bandEdges(RATED)), null);
  assert.equal(summarize([g(null, 40, 40)], bandEdges(RATED)), null);
});

test('read: a dip explained by the weakest partners says so, with the numbers', () => {
  // The Richard screenshot shape: middle band is the toughest and has the
  // lowest partners; the top band is tough too but partners were fine.
  const bands = [
    { idx: 0, tier: 'Bottom fifth', lo: 21, hi: 29, played: 21, w: 20, l: 1, pct: 95, partner: 31.1 },
    { idx: 1, tier: 'Lower-middle', lo: 29, hi: 32, played: 31, w: 19, l: 12, pct: 61, partner: 31.7 },
    { idx: 2, tier: 'Middle', lo: 32, hi: 34, played: 34, w: 14, l: 20, pct: 41, partner: 30.0 },
    { idx: 3, tier: 'Upper-middle', lo: 34, hi: 36, played: 21, w: 13, l: 8, pct: 62, partner: 33.5 },
    { idx: 4, tier: 'Top fifth', lo: 36, hi: 41, played: 36, w: 11, l: 25, pct: 31, partner: 33.8 },
  ];
  // Top band is the toughest here → plain best/toughest sentence.
  assert.match(readFor(bands, 32.3), /^Best results vs\. 21–29 \(95%, 20–1\); toughest vs\. 36–41 \(31%, 11–25\)\.$/);
  // Make the middle band the toughest → the partner sentence.
  bands[4] = { ...bands[4], w: 16, l: 20, pct: 44 };
  const read = readFor(bands, 32.3);
  assert.match(read, /The toughest band \(vs\. 32–34, 41%\)/);
  assert.match(read, /30\.0, against 32\.3/);
});

test('read: needs two sampled bands; career names tiers', () => {
  assert.equal(readFor([{ idx: 0, tier: 'Bottom fifth', played: 5, w: 4, l: 1, pct: 80 }], 40), null);
  const read = readFor([
    { idx: 0, tier: 'Bottom fifth', lo: null, hi: null, played: 5, w: 4, l: 1, pct: 80, partner: 40 },
    { idx: 4, tier: 'Top fifth', lo: null, hi: null, played: 6, w: 1, l: 5, pct: 17, partner: 41 },
  ], 40.5, false);
  assert.equal(read, 'Best results vs. the bottom fifth (80%, 4–1); toughest vs. the top fifth (17%, 1–5).');
});

test('labels: end bands are open-ended (the bottom can dip below zero)', () => {
  assert.equal(rangeLabel(0, -5, 30), 'under 30');
  assert.equal(rangeLabel(2, 41.2, 51.6), '41–52');
  assert.equal(rangeLabel(4, 56, 75), '56+');
  assert.equal(rangeLabel(1, null, null), null);
  const s = summarize([g(true, 31, 50), g(true, 66, 50)], bandEdges(RATED));
  assert.equal(s.bands[0].label, 'under 38');
  assert.equal(summarize([{ won: true, band: 0 }], null).bands[0].label, null);
});

test('bestWorst: a win-rate tie goes to the bigger sample', () => {
  const b = (idx, w, l) => ({ idx, w, l, played: w + l, pct: Math.round(w / (w + l) * 100) });
  // The real Season 2 profile that caught this: 9–0 in the bottom band, 3–0 higher up.
  const { best, worst } = bestWorst([b(0, 9, 0), b(3, 3, 0), b(4, 2, 6)]);
  assert.equal(best.idx, 0);
  assert.equal(worst.idx, 4);
  const read = readFor([{ ...b(0, 9, 0), tier: 'Bottom fifth', lo: -5, hi: 30, label: 'under 30' }, { ...b(4, 2, 6), tier: 'Top fifth', lo: 56, hi: 75, label: '56+' }], null);
  assert.equal(read, 'Best results vs. under 30 (100%, 9–0); toughest vs. 56+ (25%, 2–6).');
});

test('read: names the partner gap even when the top band is the toughest', () => {
  // Real career shape: 2–12 vs 58+ with 35.4 partners, 52–59 everywhere else.
  const bands = [
    { idx: 0, tier: 'Bottom fifth', lo: 3, hi: 26, label: 'under 26', played: 13, w: 13, l: 0, pct: 100, partner: 53.8 },
    { idx: 1, tier: 'Lower-middle', lo: 26, hi: 38, label: '26–38', played: 11, w: 10, l: 1, pct: 91, partner: 52.4 },
    { idx: 4, tier: 'Top fifth', lo: 58, hi: 80, label: '58+', played: 14, w: 2, l: 12, pct: 14, partner: 35.4 },
  ];
  assert.equal(readFor(bands, 48.6), 'The toughest band (vs. 58+, 14%) is also where partners averaged the lowest DSR — 35.4, against 48.6 across all games.');
});

test('read: never says "you" — it shows on everyone\'s public profile', () => {
  const bands = [
    { idx: 0, tier: 'Bottom fifth', lo: 3, hi: 26, label: 'under 26', played: 13, w: 13, l: 0, pct: 100, partner: 53.8 },
    { idx: 4, tier: 'Top fifth', lo: 58, hi: 80, label: '58+', played: 14, w: 2, l: 12, pct: 14, partner: 35.4 },
  ];
  for (const avg of [48.6, 30]) assert.doesNotMatch(readFor(bands, avg), /\byou(r)?\b/i);
});
