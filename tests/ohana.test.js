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
  assert.deepEqual(matchResult(L, match), { home: 1, away: 2 });
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
