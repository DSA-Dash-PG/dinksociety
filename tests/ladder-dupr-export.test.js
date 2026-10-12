// node --test tests/ladder-dupr-export.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDuprRows, makeLookup, DUPR_HEADER, toCsv, duprFileName } from '../netlify/functions/lib/ladder-dupr-export.js';
import { renderDuprExportEmail } from '../netlify/functions/lib/ladder-dupr-email.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/kc3-dupr.json', import.meta.url)));
const expected = JSON.parse(readFileSync(new URL('./fixtures/kc3-dupr-expected.json', import.meta.url)));
const event = { id: 'kc3', name: "King's Court #3 (DUPR Rated)", date: '2026-10-11', place: 'Dink House', duprRated: true };
const merges = { eli_play: { to: 'eli_roster', name: null } };
const clone = o => JSON.parse(JSON.stringify(o));

test('header is exactly DUPR\'s single-match import template', () => {
  assert.equal(DUPR_HEADER.join(','), 'matchType,event,date,playerA1,playerA1DuprId,playerA1ExternalId,playerA2,playerA2DuprId,playerA2ExternalId,playerB1,playerB1DuprId,playerB1ExternalId,playerB2,playerB2DuprId,playerB2ExternalId,teamAGame1,teamBGame1,teamAGame2,teamBGame2,teamAGame3,teamBGame3,teamAGame4,teamBGame4,teamAGame5,teamBGame5,location,scoreType');
});

test('King\'s Court #3: all 30 games, top court first, scores and IDs intact', () => {
  const lookup = makeLookup({ signups: { roster: fx.roster, waitlist: [] }, directory: {}, merges });
  const x = buildDuprRows({ event, play: fx.play, lookup });
  assert.equal(x.games, 30);
  assert.equal(x.total, 30);
  assert.deepEqual(x.skipped, []);
  const H = n => DUPR_HEADER.indexOf(n);
  const got = x.rows.map(r => [r[H('playerA1')], r[H('playerA2')], r[H('playerB1')], r[H('playerB2')], r[H('teamAGame1')], r[H('teamBGame1')]]);
  assert.deepEqual(got, expected);
  // aliased play id resolves through the merge to the roster's DUPR ID and name
  const eliRow = x.rows.find(r => r.includes('Eli Henry'));
  assert.ok(eliRow.includes('G54NGV'));
  for (const r of x.rows) {
    assert.equal(r.length, DUPR_HEADER.length);
    assert.equal(r[H('matchType')], 'D');
    assert.equal(r[H('scoreType')], 'SIDEOUT');
    assert.equal(r[H('location')], 'Dink House');
    for (const k of ['playerA1DuprId', 'playerA2DuprId', 'playerB1DuprId', 'playerB2DuprId']) assert.match(r[H(k)], /^[A-Z0-9]{6}$/);
  }
  assert.deepEqual(x.unverified.map(u => u.name), ['Dhruv', 'Peter']);
});

test('tied, unscored and no-DUPR-ID games are left out and reported', () => {
  const play = clone(fx.play);
  const r1 = play.rounds[0].courts; // r1[0] is court 5 = Court 1 (top)
  r1[0].score = { t1: 10, t2: 10, winner: 'T' };
  r1[1].score = null;
  const roster = clone(fx.roster).map(p => p.name === 'Peter' ? { ...p, duprId: '' } : p);
  const lookup = makeLookup({ signups: { roster }, directory: {}, merges });
  const x = buildDuprRows({ event, play, lookup });
  assert.equal(x.total, 30);
  assert.equal(x.games, 30 - 2 - 6);
  assert.deepEqual(x.skipped[0], { round: 1, court: 'Court 1', reason: 'tied 10-10 (DUPR needs a winner)' });
  assert.deepEqual(x.skipped[1], { round: 1, court: 'Court 2', reason: 'no score' });
  assert.deepEqual(x.missing, ['Peter']);
});

test('directory fills a sub who never signed up; unique name match rescues an unmerged id', () => {
  const play = clone(fx.play);
  const g = play.rounds[0].courts[0];
  g.team1[0] = { id: 'sub_1', name: 'Walk In' };     // not on the sheet, in the directory
  g.team1[1] = { id: 'other_id', name: 'Erick Li' }; // same person, id never merged
  const lookup = makeLookup({ signups: { roster: fx.roster }, directory: { sub_1: { name: 'Walk In', duprId: 'WALK11' } }, merges });
  const x = buildDuprRows({ event, play, lookup });
  assert.equal(x.games, 30);
  assert.ok(x.rows[0].includes('WALK11'));
  assert.ok(x.rows[0].includes('Q9MMP4'));
});

test('csv quotes commas and apostrophes stay plain', () => {
  const csv = toCsv([['a,b', 'it\'s', 'say "hi"']]);
  assert.equal(csv, '"a,b",it\'s,"say ""hi"""\r\n');
  assert.equal(duprFileName(event), 'dupr-king-s-court-3-dupr-rated-2026-10-11.csv');
});

test('email names the counts, the left-out games and the unverified players', () => {
  const html = renderDuprExportEmail({ event, export: { games: 28, total: 30, skipped: [{ round: 1, court: 'Court 1', reason: 'no score' }], missing: [], unverified: [{ name: 'Dhruv', club: '' }, { name: 'Peter', club: 'confirmed' }] }, adminUrl: 'https://dinksociety.app/admin-ladders.html' });
  assert.match(html, /28 <span[^>]*>of 30 games/);
  assert.match(html, /Round 1, Court 1: no score/);
  assert.match(html, /Peter <span[^>]*>\(says joined\)/);
  assert.match(html, /Import Matches via CSV/);
  assert.doesNotMatch(renderDuprExportEmail({ event, export: { games: 30, total: 30, skipped: [], missing: [], unverified: [] } }), /Left out|Not verified/);
});
