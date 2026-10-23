// tests/live-standings.test.js
//
// Live (unofficial) standings + rain-out carry-over, run for real against an
// in-memory stand-in for Netlify Blobs:
//   · rebuildStandings folds a started match with confirmed games into the
//     standings and player stats, flagged provisional, and drops the flag once
//     the match is finalized;
//   · admin-suspend-match freezes the confirmed games, reopens both lineups,
//     emails the captains, and the frozen games can no longer be edited by a
//     captain while the remaining lineup slots can.
//
//   node --test --experimental-test-module-mocks tests/live-standings.test.js
//
// Without that flag these tests skip themselves rather than failing the suite.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── In-memory Netlify Blobs + fake Resend ─────────────────────────
const DB = {};
function store(name) {
  const bag = DB[name] || (DB[name] = {});
  return {
    async get(key, opts) { const v = bag[key]; if (v === undefined) return null; return opts?.type === 'json' ? structuredClone(v) : JSON.stringify(v); },
    async getWithMetadata(key, opts) { const v = bag[key]; if (v === undefined) return null; return { data: opts?.type === 'json' ? structuredClone(v) : JSON.stringify(v), etag: 'e' + JSON.stringify(v).length }; },
    async setJSON(key, val) { bag[key] = structuredClone(val); return { modified: true }; },
    async set(key, val) { bag[key] = val; },
    async list(opts) { const p = opts?.prefix || ''; return { blobs: Object.keys(bag).filter(k => k.startsWith(p)).map(key => ({ key })) }; },
    async delete(key) { delete bag[key]; },
  };
}
const MAIL = [];
class FakeResend {
  constructor() { this.emails = { send: async (p) => { MAIL.push(p); return { data: { id: 'm' + MAIL.length } }; } }; }
}

const g = (h, a) => ({ home: h, away: a, homeEntry: { home: h, away: a, by: 'x', at: 't' }, awayEntry: { home: h, away: a, by: 'y', at: 't' } });
const ROSTER_A = [
  { id: 'a1', name: 'Ann A', gender: 'F', email: 'ann@x.test', isCaptain: true },
  { id: 'a2', name: 'Bea A', gender: 'F', email: 'bea@x.test' },
  { id: 'a3', name: 'Cal A', gender: 'M', email: 'cal@x.test' },
  { id: 'a4', name: 'Dan A', gender: 'M', email: 'dan@x.test' },
  { id: 'a5', name: 'Eve A', gender: 'F', email: 'eve@x.test' },
];
const ROSTER_B = [
  { id: 'b1', name: 'Fay B', gender: 'F', email: 'fay@x.test', isCaptain: true },
  { id: 'b2', name: 'Gia B', gender: 'F', email: 'gia@x.test' },
  { id: 'b3', name: 'Hal B', gender: 'M', email: 'hal@x.test' },
  { id: 'b4', name: 'Ian B', gender: 'M', email: 'ian@x.test' },
];
function lineupFor(teamId, roster) {
  const f = roster.filter(p => p.gender === 'F'), m = roster.filter(p => p.gender === 'M');
  const pair = (x, y) => ({ p1: x.id, p2: y.id, p1Name: x.name, p2Name: y.name });
  const games = {};
  for (const r of [1, 2]) {
    games[`r${r}g1`] = pair(f[0], f[1]);
    games[`r${r}g2`] = pair(m[0], m[1]);
    games[`r${r}g3`] = pair(f[0], m[0]);
    games[`r${r}g4`] = pair(f[1], m[1]);
    games[`r${r}g5`] = pair(f[0], m[1]);
    games[`r${r}g6`] = pair(f[1], m[0]);
  }
  return { matchId: 'live', teamId, teamName: teamId, games, lockedAt: '2026-10-22T00:00:00.000Z', lockedBy: 'cap' };
}

function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  MAIL.length = 0;
  const tA = { id: 'A', name: 'Alpha', circuit: 'II', division: '3.5M', seasonId: 'circuit-ii', captainEmail: 'ann@x.test', roster: ROSTER_A };
  const tB = { id: 'B', name: 'Bravo', circuit: 'II', division: '3.5M', seasonId: 'circuit-ii', captainEmail: 'fay@x.test', roster: ROSTER_B };
  DB.teams = { 'team/A.json': tA, 'team/B.json': tB };
  DB.seasons = { 'circuit-ii': { id: 'circuit-ii', weeks: 10 } };
  // Week 1: official (finalized) — Alpha 4, Bravo 0.
  DB.schedule = {
    'schedule/II/3.5M/week-1.json': { circuit: 'II', division: '3.5M', week: 1, matches: [{
      id: 'w1', teamA: { id: 'A', name: 'Alpha' }, teamB: { id: 'B', name: 'Bravo' },
      scheduledAt: '2026-10-16T01:00:00.000Z', finalizedAt: '2026-10-16T04:00:00.000Z', scoreA: 4, scoreB: 0,
      round1: { homeGames: 4, awayGames: 2, homePoints: 2, awayPoints: 0, scoredGames: 6 },
      round2: { homeGames: 5, awayGames: 1, homePoints: 2, awayPoints: 0, scoredGames: 6 },
    }] },
    // Week 2: started last night, round 1 confirmed (Bravo 4–2), one R2 game confirmed, rest open.
    'schedule/II/3.5M/week-2.json': { circuit: 'II', division: '3.5M', week: 2, matches: [{
      id: 'live', teamA: { id: 'A', name: 'Alpha' }, teamB: { id: 'B', name: 'Bravo' },
      scheduledAt: '2026-10-23T01:00:00.000Z',
    }] },
    // Week 3: not started — a stray confirmed game must NOT count.
    'schedule/II/3.5M/week-3.json': { circuit: 'II', division: '3.5M', week: 3, matches: [{
      id: 'future', teamA: { id: 'A', name: 'Alpha' }, teamB: { id: 'B', name: 'Bravo' },
      scheduledAt: '2026-11-06T01:00:00.000Z',
    }] },
  };
  DB.lineups = {
    'lineup/w1/A.json': lineupFor('A', ROSTER_A), 'lineup/w1/B.json': lineupFor('B', ROSTER_B),
    'lineup/live/A.json': lineupFor('A', ROSTER_A), 'lineup/live/B.json': lineupFor('B', ROSTER_B),
  };
  DB.scores = {
    'score/w1.json': { matchId: 'w1', games: {
      r1g1: g(11, 3), r1g2: g(11, 5), r1g3: g(7, 11), r1g4: g(11, 9), r1g5: g(11, 1), r1g6: g(4, 11),
      r2g1: g(11, 3), r2g2: g(11, 5), r2g3: g(11, 2), r2g4: g(11, 9), r2g5: g(11, 1), r2g6: g(4, 11),
    }, finalizedAt: '2026-10-16T04:00:00.000Z' },
    'score/live.json': { matchId: 'live', games: {
      r1g1: g(3, 11), r1g2: g(11, 5), r1g3: g(7, 11), r1g4: g(11, 9), r1g5: g(6, 11), r1g6: g(4, 11),
      r2g1: g(11, 8),
      r2g2: { home: null, away: null, homeEntry: { home: 11, away: 2, by: 'x', at: 't' }, awayEntry: null },
    } },
    'score/future.json': { matchId: 'future', games: { r1g1: g(11, 0) } },
  };
}

const NOW = Date.parse('2026-10-23T16:00:00.000Z'); // the morning after week 2's night
let skip = false, S, Suspend, CapLineup, CapScore, CAPTAIN = null;
try {
  process.env.RESEND_API_KEY = 'test';
  process.env.SITE_URL = 'https://example.test';
  mock.module('@netlify/blobs', { namedExports: { getStore: (arg) => store(typeof arg === 'string' ? arg : arg.name) } });
  mock.module('resend', { namedExports: { Resend: FakeResend } });
  mock.module(new URL('../netlify/functions/lib/auth.js', import.meta.url).href, { namedExports: {
    verifyAdminSession: async () => ({ valid: true, payload: { email: 'admin@x.test' } }),
    verifyCaptainSession: async () => CAPTAIN ? { valid: true, payload: CAPTAIN } : { valid: false, error: 'Unauthorized' },
    verifyPlayerSession: async () => ({ valid: false }),
    unauthResponse: (e) => new Response(JSON.stringify({ error: e || 'Unauthorized' }), { status: 401 }),
  } });
  mock.module(new URL('../netlify/functions/lib/activity-log.js', import.meta.url).href, { namedExports: { logActivity: async () => null } });
  mock.module(new URL('../netlify/functions/lib/lineup-notify.js', import.meta.url).href, { namedExports: { notifyTeamOfLock: async () => ({ sent: 0 }) } });
  mock.module(new URL('../netlify/functions/lib/availability.js', import.meta.url).href, { namedExports: {
    getTeamAvailability: async () => ({ players: {} }), unavailableIds: () => new Set(),
  } });
  S = await import('../netlify/functions/lib/standings.js');
  ({ default: Suspend } = await import('../netlify/functions/admin-suspend-match.js'));
  ({ default: CapLineup } = await import('../netlify/functions/captain-lineup.js'));
  ({ default: CapScore } = await import('../netlify/functions/captain-score.js'));
} catch (e) {
  skip = 'needs --experimental-test-module-mocks (' + (e && e.message ? e.message.slice(0, 160) : e) + ')';
}

const realNow = Date.now;
function freeze() { Date.now = () => NOW; }
function thaw() { Date.now = realNow; }

test('a started match with confirmed games counts live, flagged unofficial', { skip }, async () => {
  seed(); freeze();
  try {
    const { standings, playerStats } = await S.rebuildStandings('II');
    const rows = standings.divisions['3.5M'].teams;
    const A = rows.find(t => t.teamId === 'A'), B = rows.find(t => t.teamId === 'B');

    // Week 1 official (A 4–0) + week 2 round 1 live (B took R1 4–2 → +2 for B).
    assert.equal(A.matchPointsFor, 4);
    assert.equal(B.matchPointsFor, 2);
    assert.equal(A.matchesPlayed, 2);
    assert.equal(A.roundsPlayed, 3, 'two official rounds + the one live round that is complete');
    assert.equal(A.wins, 2); assert.equal(A.losses, 1);
    assert.equal(B.wins, 1); assert.equal(B.losses, 2);
    // Games: week 1 A 9–3; live R1 A 2–4 + R2G1 A 1–0 → A 12–7.
    assert.equal(A.totalGamesWon, 12); assert.equal(A.totalGamesLost, 7);
    assert.equal(A.provisional, true); assert.equal(B.provisional, true);
    assert.equal(A.pendingMatches, 1);
    assert.equal(A.pendingRoundPts, 2, 'round 2 is still open');
    assert.equal(standings.provisional.count, 1);
    assert.equal(standings.provisional.matches[0].id, 'live');
    assert.equal(standings.provisional.matches[0].gamesConfirmed, 7);
    assert.equal(standings.divisions['3.5M'].provisional, 1);
    // The week-3 stray confirmed game never counted.
    assert.equal(standings.provisional.matches.some(m => m.id === 'future'), false);

    // Players in the live match carry the flag; their stats include the live games.
    assert.equal(playerStats.provisional.count, 1);
    assert.equal(playerStats.players.a1.provisional, true);
    assert.equal(playerStats.players.a1.gamesPlayed > 3, true);
    const wk2 = standings.weeklyTopPerformers.find(w => w.week === 2);
    assert.equal(wk2.provisional, true);
    const wk1 = standings.weeklyTopPerformers.find(w => w.week === 1);
    assert.equal(wk1.provisional, false);

    // The schedule blob is never written with live numbers.
    assert.equal(DB.schedule['schedule/II/3.5M/week-2.json'].matches[0].scoreA, undefined);
  } finally { thaw(); }
});

test('finalizing the match makes it official — flags clear, numbers stand', { skip }, async () => {
  seed(); freeze();
  try {
    const wk = DB.schedule['schedule/II/3.5M/week-2.json'];
    Object.assign(wk.matches[0], {
      finalizedAt: '2026-10-23T05:00:00.000Z', scoreA: 0, scoreB: 2,
      round1: { homeGames: 2, awayGames: 4, homePoints: 0, awayPoints: 2, scoredGames: 6 },
      round2: { homeGames: 1, awayGames: 0, homePoints: 0, awayPoints: 0, scoredGames: 1 },
    });
    const { standings } = await S.rebuildStandings('II');
    const B = standings.divisions['3.5M'].teams.find(t => t.teamId === 'B');
    assert.equal(standings.provisional.count, 0);
    assert.equal(B.provisional, false);
    assert.equal(B.matchPointsFor, 2);
  } finally { thaw(); }
});

test('admin suspend: confirmed games freeze, lineups reopen, captains emailed', { skip }, async () => {
  seed(); freeze();
  try {
    const req = new Request('https://x.test/.netlify/functions/admin-suspend-match?action=suspend&circuit=II', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matchId: 'live', resumeAt: '2026-10-30T00:00:00.000Z', note: 'Courts 5 & 6' }),
    });
    const res = await Suspend(req);
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.results[0].frozen, 7);
    assert.equal(body.results[0].remaining, 5);
    assert.equal(body.results[0].lineupsReopened, 2);

    const m = DB.schedule['schedule/II/3.5M/week-2.json'].matches[0];
    assert.deepEqual(m.suspended.lockedSlots, ['r1g1', 'r1g2', 'r1g3', 'r1g4', 'r1g5', 'r1g6', 'r2g1']);
    assert.equal(m.suspended.resumeAt, '2026-10-30T00:00:00.000Z');
    assert.equal(m.suspended.snapshot.gamesHome, 3);
    assert.equal(m.suspended.snapshot.gamesAway, 4);
    assert.equal(m.suspended.snapshot.matchPoints.away, 2);
    assert.equal(m.finalizedAt, undefined);
    assert.equal(DB.lineups['lineup/live/A.json'].lockedAt, null);
    assert.equal(DB.lineups['lineup/live/B.json'].lockedAt, null);
    // Scores untouched, standings rebuilt and still unofficial.
    assert.equal(DB.scores['score/live.json'].games.r1g1.home, 3);
    assert.equal(DB.standings['standings/II.json'].provisional.count, 1);
    assert.equal(DB.standings['standings/II.json'].provisional.matches[0].suspended, true);

    // Both captains got the mail, nobody else.
    assert.deepEqual(MAIL.map(x => x.to).sort(), ['ann@x.test', 'fay@x.test']);
    assert.match(MAIL[0].subject, /Week 2 resumes/);
    assert.match(MAIL[0].html, /Courts 5 &amp; 6|Courts 5 & 6/);
  } finally { thaw(); }
});

test('captain lineup: frozen games keep their pair, the rest can change', { skip }, async () => {
  seed(); freeze();
  try {
    await Suspend(new Request('https://x.test/f?action=suspend&circuit=II', {
      method: 'POST', body: JSON.stringify({ matchId: 'live', resumeAt: '2026-10-30T00:00:00.000Z', notify: false }),
    }));
    CAPTAIN = { team: DB.teams['team/A.json'], user: { email: 'ann@x.test', role: 'captain' } };

    // GET: the suspension is reported and the opponent's frozen pairs are visible.
    const getRes = await CapLineup(new Request('https://x.test/f?match=live'));
    const got = await getRes.json();
    assert.equal(got.suspended.lockedCount, 7);
    assert.equal(got.status.revealed, false);
    assert.equal(Object.keys(got.oppLineup.games).length, 7, 'only the frozen games of the opponent');
    assert.equal(got.oppLineup.games.r2g2, undefined);
    assert.match(got.status.hardLockAt, /^2026-10-29T23:50/);

    // PUT: try to change a frozen game and a remaining game. Frozen stays; the
    // rest changes (Eve replaces Bea in R2G4, a woman-for-woman swap).
    const games = structuredClone(DB.lineups['lineup/live/A.json'].games);
    games.r1g1 = { p1: 'a5', p2: 'a2' };   // frozen → ignored
    games.r2g4 = { p1: 'a5', p2: 'a4' };   // open → applied
    const putRes = await CapLineup(new Request('https://x.test/f?match=live', {
      method: 'PUT', body: JSON.stringify({ games, action: 'save' }),
    }));
    const put = await putRes.json();
    assert.equal(putRes.status, 200, JSON.stringify(put));
    const saved = DB.lineups['lineup/live/A.json'].games;
    assert.equal(saved.r1g1.p1, 'a1', 'frozen game kept its original pair');
    assert.equal(saved.r1g1.p2, 'a2');
    assert.equal(saved.r2g4.p1, 'a5', 'open game took the change');
    assert.equal(saved.r2g4.p2, 'a4');
  } finally { thaw(); CAPTAIN = null; }
});

test('captain score: a frozen game cannot be edited', { skip }, async () => {
  seed(); freeze();
  try {
    await Suspend(new Request('https://x.test/f?action=suspend&circuit=II', {
      method: 'POST', body: JSON.stringify({ matchId: 'live', resumeAt: '2026-10-30T00:00:00.000Z', notify: false }),
    }));
    // Both re-lock and play resumes: pretend it's the resume time.
    DB.lineups['lineup/live/A.json'].lockedAt = '2026-10-29T23:00:00.000Z';
    DB.lineups['lineup/live/B.json'].lockedAt = '2026-10-29T23:00:00.000Z';
    Date.now = () => Date.parse('2026-10-30T00:05:00.000Z');
    CAPTAIN = { team: DB.teams['team/A.json'], user: { email: 'ann@x.test', role: 'captain' } };

    const getRes = await CapScore(new Request('https://x.test/f?match=live'));
    const got = await getRes.json();
    assert.equal(got.revealed, true);
    assert.equal(got.score.games.r1g1.frozen, true);
    assert.equal(got.score.games.r2g2.frozen, false);

    const bad = await CapScore(new Request('https://x.test/f?match=live', {
      method: 'PUT', body: JSON.stringify({ games: { r1g1: { home: 11, away: 9 } } }),
    }));
    assert.equal(bad.status, 409);
    assert.match((await bad.json()).error, /final/);

    const ok = await CapScore(new Request('https://x.test/f?match=live', {
      method: 'PUT', body: JSON.stringify({ games: { r2g3: { home: 11, away: 7 } } }),
    }));
    assert.equal(ok.status, 200, await ok.text());
    assert.equal(DB.scores['score/live.json'].games.r2g3.homeEntry.home, 11);
  } finally { thaw(); CAPTAIN = null; }
});
