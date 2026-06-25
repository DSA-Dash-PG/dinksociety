// tests/bracket.test.js
// Unit tests for the pure bracket helpers (no I/O). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  regularRounds, bracketSupported, bracketSlots, buildBracketWeeks,
  phaseForWeek, rankTeams, matchResult, resolveBracketDisplay, PHASE,
} from '../netlify/functions/lib/bracket.js';

const TEAMS = [
  { id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' },
  { id: 't3', name: 'Charlie' }, { id: 't4', name: 'Delta' },
  { id: 't5', name: 'Echo' }, { id: 't6', name: 'Foxtrot' },
];

// A finalized RR match helper. mpA/mpB = match points; rally pts optional.
function rr(week, a, b, mpA, mpB, gwA = mpA, gwB = mpB) {
  return {
    week, finalizedAt: '2026-01-01T00:00:00Z',
    teamA: { id: a.id, name: a.name }, teamB: { id: b.id, name: b.name },
    scoreA: mpA, scoreB: mpB,
    round1: { homeGames: gwA, awayGames: gwB }, round2: { homeGames: 0, awayGames: 0 },
    pointsA: mpA * 10, pointsB: mpB * 10,
  };
}

test('regularRounds + bracket support', () => {
  assert.equal(regularRounds(6), 5);
  assert.equal(bracketSupported(6), true);
  assert.equal(bracketSupported(4), false);
  assert.equal(bracketSlots(6).length, 8); // 3 rivalry + 3 playoff + 2 champ
});

test('phaseForWeek maps 6/7/8 to rivalry/playoff/championship', () => {
  assert.equal(phaseForWeek(5, 6), null);
  assert.equal(phaseForWeek(6, 6).phase, PHASE.RIVALRY);
  assert.equal(phaseForWeek(7, 6).phase, PHASE.PLAYOFF);
  assert.equal(phaseForWeek(8, 6).phase, PHASE.CHAMPIONSHIP);
});

test('buildBracketWeeks emits Wk6/7/8 with distinct court sets', () => {
  const wk = buildBracketWeeks({ circuit: 'I', division: '3.5M', numTeams: 6 });
  assert.deepEqual(Object.keys(wk).map(Number).sort((a, b) => a - b), [6, 7, 8]);
  assert.equal(wk[6].length, 3);
  assert.equal(wk[7].length, 3);
  assert.equal(wk[8].length, 2);
  // distinct sets within a week
  const sets6 = wk[6].map(m => m.courtSet);
  assert.equal(new Set(sets6).size, 3);
  // ids are stable/slot-based
  assert.ok(wk[6].some(m => m.id.endsWith('w6_rivalry-1')));
  assert.ok(wk[8].some(m => m.bracketSlot === 'gold'));
});

test('rankTeams: no games → alphabetical', () => {
  const ranks = rankTeams({ matches: [], teamList: TEAMS, cutoffWeek: 5 });
  assert.deepEqual(ranks.map(t => t.name), ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']);
});

test('rankTeams: match points then games then diff; respects cutoff', () => {
  // Build a small set where Foxtrot dominates, Alpha second.
  const matches = [
    rr(1, TEAMS[5], TEAMS[0], 4, 0), // Foxtrot beats Alpha
    rr(1, TEAMS[1], TEAMS[2], 3, 1), // Bravo beats Charlie
    rr(2, TEAMS[0], TEAMS[3], 4, 0), // Alpha beats Delta
    rr(6, TEAMS[0], TEAMS[5], 4, 0), // (week 6 — must be ignored at cutoff 5)
  ];
  const ranks = rankTeams({ matches, teamList: TEAMS, cutoffWeek: 5 });
  // Foxtrot 4, Alpha 4 — tie on MP, Foxtrot more games won? Alpha 4gw, Foxtrot 4gw.
  // Tie broken by head-to-head (Foxtrot beat Alpha) → Foxtrot ahead.
  assert.equal(ranks[0].name, 'Foxtrot');
  assert.equal(ranks[1].name, 'Alpha');
});

test('resolve rivalry: previews from RR ranks, locks when RR complete', () => {
  const teamList = TEAMS;
  // Partial RR (not complete) → preview, not locked.
  const partial = [rr(1, TEAMS[0], TEAMS[1], 4, 0)];
  const bracket = Object.values(buildBracketWeeks({ circuit: 'I', division: 'D', numTeams: 6 })).flat();
  let res = resolveBracketDisplay({ realMatches: partial, bracketMatches: bracket, teamList, numTeams: 6 });
  const riv1 = res.find(m => m.bracketSlot === 'rivalry-1');
  assert.equal(riv1.seedLocked, false);
  assert.ok(riv1.teamA && riv1.teamB); // still shows a projection
  assert.equal(riv1.seedLabelA, '#1 Seed');

  // Full RR (15 finalized matches) → locked.
  const full = [];
  let wk = 1, count = 0;
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
    full.push(rr(wk, TEAMS[i], TEAMS[j], i < j ? 4 : 0, i < j ? 0 : 4));
    if (++count % 3 === 0) wk++;
  }
  res = resolveBracketDisplay({ realMatches: full, bracketMatches: bracket, teamList, numTeams: 6 });
  assert.equal(res.find(m => m.bracketSlot === 'rivalry-1').seedLocked, true);
});

test('championship resolves winners/losers of semis once played', () => {
  const teamList = TEAMS;
  // Pre-seed playoff semis as concrete + finalized via persisted lock fields.
  const bracket = Object.values(buildBracketWeeks({ circuit: 'I', division: 'D', numTeams: 6 })).flat();
  const semiA = bracket.find(m => m.bracketSlot === 'semi-A');
  const semiB = bracket.find(m => m.bracketSlot === 'semi-B');
  // #1 Alpha beats #4 Delta; #2 Bravo beats #3 Charlie.
  Object.assign(semiA, { teamA: TEAMS[0], teamB: TEAMS[3], scoreA: 4, scoreB: 0, finalizedAt: 'x', round1: { homeGames: 4, awayGames: 0 }, round2: {} });
  Object.assign(semiB, { teamA: TEAMS[1], teamB: TEAMS[2], scoreA: 3, scoreB: 1, finalizedAt: 'x', round1: { homeGames: 3, awayGames: 1 }, round2: {} });
  const res = resolveBracketDisplay({ realMatches: [], bracketMatches: bracket, teamList, numTeams: 6 });
  const gold = res.find(m => m.bracketSlot === 'gold');
  const bronze = res.find(m => m.bracketSlot === 'bronze');
  assert.equal(gold.teamA.name, 'Alpha');
  assert.equal(gold.teamB.name, 'Bravo');
  assert.equal(gold.seedLocked, true);
  assert.equal(bronze.teamA.name, 'Delta');
  assert.equal(bronze.teamB.name, 'Charlie');
});

test('pipeline: full RR + rivalry → playoffs lock with all 6 teams seeded', () => {
  // Full round-robin: lower index beats higher, 4-0.
  const full = [];
  let wk = 1, count = 0;
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
    full.push(rr(wk, TEAMS[i], TEAMS[j], 4, 0));
    if (++count % 3 === 0) wk++;
  }
  // Synthesize the bracket placeholders, then play out rivalry (week 6).
  const bracket = Object.values(buildBracketWeeks({ circuit: 'I', division: 'D', numTeams: 6 })).flat();
  let res = resolveBracketDisplay({ realMatches: full, bracketMatches: bracket, teamList: TEAMS, numTeams: 6 });
  // Rivalry locked, playoffs still projected (not locked) until rivalry is final.
  assert.equal(res.find(m => m.bracketSlot === 'rivalry-1').seedLocked, true);
  assert.equal(res.find(m => m.bracketSlot === 'semi-A').seedLocked, false);

  // Finalize the three rivalry matches on the bracket blobs themselves.
  for (const m of bracket) {
    if (m.phase !== 'rivalry') continue;
    const r = res.find(x => x.id === m.id);
    Object.assign(m, {
      teamA: r.teamA, teamB: r.teamB, scoreA: 4, scoreB: 0, finalizedAt: 'x',
      round1: { homeGames: 4, awayGames: 0 }, round2: {}, pointsA: 40, pointsB: 0,
    });
  }
  res = resolveBracketDisplay({ realMatches: full, bracketMatches: bracket, teamList: TEAMS, numTeams: 6 });
  const semiA = res.find(m => m.bracketSlot === 'semi-A');
  const semiB = res.find(m => m.bracketSlot === 'semi-B');
  const cons = res.find(m => m.bracketSlot === 'consolation');
  assert.equal(semiA.seedLocked, true);
  // All six teams appear exactly once across the playoff matches.
  const ids = [semiA, semiB, cons].flatMap(m => [m.teamA.id, m.teamB.id]).sort();
  assert.deepEqual(ids, TEAMS.map(t => t.id).sort());
});

test('matchResult breaks MP ties on games won, else null', () => {
  assert.equal(matchResult({ finalizedAt: 'x', teamA: TEAMS[0], teamB: TEAMS[1], scoreA: 4, scoreB: 0 }).winner.name, 'Alpha');
  const tie = matchResult({ finalizedAt: 'x', teamA: TEAMS[0], teamB: TEAMS[1], scoreA: 2, scoreB: 2, round1: { homeGames: 1, awayGames: 1 }, round2: {} });
  assert.equal(tie, null);
});
