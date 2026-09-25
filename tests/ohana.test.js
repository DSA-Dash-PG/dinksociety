// tests/ohana.test.js — private South Bay Ohana page (PVTC Fall 2026 mini league).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seedLeague, isOurs, isByeWeek, computeStandings, computeStats, matchResult, normSlots,
  lineupChangedFor, laMs, findMatch, describeMatchChange, OUR_TEAM_ID,
} from '../netlify/functions/lib/ohana-core.js';

const withRoster = () => {
  const L = seedLeague();
  L.roster = ['a', 'b', 'c', 'd'].map(x => ({ email: `${x}@x.com`, name: x.toUpperCase() + ' Player' }));
  return L;
};

test('seed matches the PVTC sheet: our 5 regular + RR matches, bye in week 1', () => {
  const L = seedLeague();
  const ours = L.weeks.filter(w => w.matches.some(m => isOurs(L, m))).map(w => w.id);
  assert.deepEqual(ours, ['w2', 'w3', 'w4', 'w5', 'w6']);
  assert.equal(isByeWeek(L, L.weeks[0]), true);
  assert.equal(findMatch(L, 'w6-m3').match.courts, '11-3, 11-4');
  assert.equal(L.teams.length, 5);
});

test('match start is 7pm Pacific across the DST change', () => {
  assert.equal(new Date(laMs('2026-10-27', '7:00 PM')).toISOString(), '2026-10-28T02:00:00.000Z'); // PDT
  assert.equal(new Date(laMs('2026-11-17', '7:00 PM')).toISOString(), '2026-11-18T03:00:00.000Z'); // PST
});

test('game scores roll up to the match result, stats and standings', () => {
  const L = withRoster();
  const { match } = findMatch(L, 'w2-m2'); // AceHoles (home) vs Ohana (away)
  match.slots = normSlots([
    { no: 1, players: ['a@x.com', 'b@x.com'], opp: ['Z', 'Y'], us: 11, them: 7 },
    { no: 2, players: ['a@x.com', 'c@x.com'], us: 9, them: 11 },
    { no: 3, players: ['c@x.com', 'd@x.com'], us: 11, them: 4 },
  ]);
  const mr = matchResult(L, match);
  assert.deepEqual([mr.home, mr.away, mr.ptsHome, mr.ptsAway], [1, 2, 0, 2]); // round 1 only: 2-1 to us
  const st = computeStats(L);
  assert.deepEqual([st.team.mw, st.team.gw, st.team.gl], [1, 2, 1]);
  const a = st.players.find(p => p.email === 'a@x.com');
  assert.deepEqual([a.gp, a.w, a.l, a.diff], [2, 1, 1, 2]);
  assert.equal(st.oppPlayers.find(o => o.name === 'Z').l, 1);
  // Other teams' results only need games won
  findMatch(L, 'w1-m1').match.result = { home: 8, away: 4 };
  const table = computeStandings(L);
  assert.equal(table[0].name, 'Net Flicks');
  assert.equal(table.find(r => r.teamId === OUR_TEAM_ID).gw, 2);
});

test('lineup change emails only the players whose games moved', () => {
  const L = withRoster();
  const before = normSlots([{ no: 1, players: ['a@x.com', 'b@x.com'] }, { no: 2, players: ['c@x.com', 'd@x.com'] }]);
  const after = normSlots([{ no: 1, players: ['a@x.com', 'b@x.com'] }, { no: 2, players: ['c@x.com', 'a@x.com'] }]);
  assert.deepEqual(lineupChangedFor(L, before, after).sort(), ['a@x.com', 'c@x.com', 'd@x.com']);
});

test('schedule edits describe what changed', () => {
  const L = seedLeague();
  const { week, match } = findMatch(L, 'w3-m2');
  const after = { ...match, date: '2026-11-10', courts: '11-3, 11-4' };
  const lines = describeMatchChange(L, match, after, week, week);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Oct 13 → .*Nov 10/);
});

import { roundPoints, typeOf, lineupWarnings, eligibility } from '../netlify/functions/lib/ohana-core.js';

test('PVTC format: WD, MD, then 4 mixed each round; 2/1/0 points per round', () => {
  assert.deepEqual([1, 2, 3, 6, 7, 8, 12].map(typeOf), ['WD', 'MD', 'MXD', 'MXD', 'WD', 'MD', 'MXD']);
  assert.deepEqual(roundPoints(4, 2), [2, 0]);
  assert.deepEqual(roundPoints(3, 3), [1, 1]);
  const L = seedLeague();
  findMatch(L, 'w1-m1').match.result = { r1: { home: 4, away: 2 }, r2: { home: 3, away: 3 } }; // Net Flicks 3 pts, Dink Life 1
  findMatch(L, 'w1-m2').match.result = { r1: { home: 1, away: 5 }, r2: { home: 2, away: 4 } }; // AceHoles 4
  const t = computeStandings(L);
  assert.deepEqual(t.slice(0, 3).map(r => [r.name, r.pts]), [['AceHoles', 4], ['Net Flicks', 3], ['Dink Life', 1]]);
  const nf = t.find(r => r.name === 'Net Flicks');
  assert.deepEqual([nf.gw, nf.gl, nf.mw, nf.mt], [7, 5, 1, 0]);
});

test('points tie is broken head-to-head before games won', () => {
  const L = seedLeague();
  // Dink Life beats Net Flicks on points but wins fewer games overall elsewhere
  findMatch(L, 'w1-m1').match.result = { r1: { home: 2, away: 4 }, r2: { home: 2, away: 4 } };  // NF 0, DL 4
  findMatch(L, 'w4-m1').match.result = { r1: { home: 0, away: 6 }, r2: { home: 0, away: 6 } };  // PJ 0, NF 4
  findMatch(L, 'w2-m1').match.result = { r1: { home: 3, away: 3 }, r2: { home: 3, away: 3 } };  // DL 2, PJ 2
  findMatch(L, 'w5-m2').match.result = { r1: { home: 6, away: 0 }, r2: { home: 3, away: 3 } };  // NF 3, AH 1  → NF 7 total
  findMatch(L, 'w3-m1').match.result = { r1: { home: 2, away: 4 }, r2: { home: 4, away: 2 } };  // AH 2, DL 2 → DL 8
  // DL 8 pts, NF 7 — make it a tie: give NF one more point
  findMatch(L, 'w6-m1').match.result = { r1: { home: 3, away: 3 }, r2: { home: 0, away: 0 } }; // NF 1 (RR), DL 1 → DL 9, NF 8
  const t = computeStandings(L);
  assert.equal(t[0].name, 'Dink Life');
});

test('lineup warnings: repeat partner, 4+ games a round, gender fit, player count', () => {
  const L = seedLeague();
  L.roster = [
    { email: 'a@x', name: 'Ann', gender: 'F' }, { email: 'b@x', name: 'Bea', gender: 'F' },
    { email: 'c@x', name: 'Cal', gender: 'M' }, { email: 'd@x', name: 'Dan', gender: 'M' },
  ];
  const w = lineupWarnings(L, [
    { no: 1, players: ['a@x', 'b@x'] },        // WD ok
    { no: 2, players: ['c@x', 'a@x'] },        // MD with a woman
    { no: 3, players: ['a@x', 'c@x'] },        // repeat partner in round 1
    { no: 4, players: ['a@x', 'd@x'] },        // Ann's 4th game in round 1
  ]);
  assert.ok(w.some(x => /men's doubles/.test(x)));
  assert.ok(w.some(x => /paired twice/.test(x)));
  assert.ok(w.some(x => /Ann is in 4 games/.test(x)));
  assert.equal(lineupWarnings(L, [{ no: 1, players: ['a@x', 'b@x'] }]).some(x => /at least 4/.test(x)), true);
});

test('playoff eligibility is 1/3 of our regular-season matches', () => {
  const L = seedLeague();
  const e = eligibility(L, Date.parse('2026-09-01'));
  assert.equal(e.total, 5); assert.equal(e.needed, 2);
  findMatch(L, 'w2-m2').match.slots = [{ no: 1, players: ['a@x', 'b@x'] }];
  assert.equal(eligibility(L, Date.parse('2026-10-08')).played['a@x'], 1);
  assert.equal(eligibility(L, Date.parse('2026-10-05')).played['a@x'], undefined);
});
