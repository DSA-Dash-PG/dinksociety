// =============================================================
// POST /api/admin-seed-test-season
//
// Seeds an ISOLATED test season so league staff can vet the scoring
// system end-to-end without touching any real season data.
//
//   season id : circuit-test   (→ circuit letter "TEST")
//   division  : test-mixed      (one division, 6 teams)
//   teams     : 6, varied 6–12 player rosters, gender balanced
//   schedule  : 5-week single round-robin (3 matches / week)
//   weeks 1..N: pre-finalized with realistic scores (default N=2)
//   remaining : open with locked lineups, ready for live scoring
//
// The seeder writes the `standings/TEST.json` and `player-stats/TEST.json`
// aggregates DIRECTLY (using the league's own bonus + composite formulas)
// rather than calling rebuildStandings, so every public page is populated
// with coherent data for verifying read/render wiring. Live-scoring an
// open match still goes through the real captain-score → rebuildStandings
// path (which is what staff are testing).
//
// EVERYTHING written here is tagged `isTest: true` and keyed under the
// TEST circuit / test- id prefixes, so admin-wipe-test-season removes it
// in one shot and can NEVER touch a real season.
//
// Body (JSON, all optional):
//   { captainEmails: ["a@x.com", ...up to 6],
//     finalizedWeeks: 2,
//     playersPerTeam: [6,8,8,10,12,12] }
//
// Admin-only. Re-running wipes the previous test season first (idempotent).
// =============================================================

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import { wipeTestSeason } from './lib/test-season.js';
import { assignCourtSets } from './lib/courts.js';

// ---- Test season identity (keep in sync with lib/test-season.js) ----
const SEASON_ID = 'circuit-test';
const CIRCUIT   = 'TEST';
const DIVISION  = 'test-mixed';
const DIV_LABEL = 'Test Division · 3.0–3.5 Mixed';

const TEAM_NAMES  = ['Test Dinkers', 'Test Smashers', 'Test Net Ninjas', 'Test Lobsters', 'Test Paddlers', 'Test Kitcheners'];
const TEAM_EMOJIS = ['🧪', '🔬', '⚗️', '📊', '🧫', '🧮'];
const DEFAULT_SIZES = [6, 8, 8, 10, 12, 12];

const FIRST_M = ['Marcus','Devon','James','Tyler','Chris','Jordan','Alex','Blake','Ryan','Kai','Sam','Drew','Cole','Nate','Jalen','Derek','Omar','Ravi','Leo','Trent','Hugo','Mateo','Ivan','Pete'];
const FIRST_F = ['Saya','Priya','Mia','Ana','Casey','Morgan','Dana','Avery','Quinn','Riley','Nina','Jade','Luna','Zoe','Emi','Tara','Dani','Skye','Val','Kira','Beth','Lena','Gigi','Wren'];
const LAST = ['Thompson','Kim','Rodriguez','Chen','Williams','Patel','Davis','Martinez','Lee','Brown','Taylor','Anderson','Wilson','Moore','Jackson','Harris','Clark','Lewis','Walker','Hall','Young','Allen','King','Wright','Nguyen','Garcia','Park','Singh'];

// Gender slot types (mirrors lib/standings.js)
const SLOT_TYPE = {
  r1g1: 'womens', r1g2: 'mens', r1g3: 'mixed', r1g4: 'mixed', r1g5: 'mixed', r1g6: 'mixed',
  r2g1: 'womens', r2g2: 'mens', r2g3: 'mixed', r2g4: 'mixed', r2g5: 'mixed', r2g6: 'mixed',
};
const SLOT_KEYS = Object.keys(SLOT_TYPE);

// Scoring/bonus constants (mirror lib/standings.js so seeded aggregates
// match what the system would produce if scoring worked end-to-end).
const PLACEMENT_BONUS    = [100, 75, 50, 30, 15, 0];
const BONUS_MATCH_WIN    = 10;
const BONUS_MATCH_TIE    = 5;
const BONUS_SWEEP_EXTRA  = 5;
const BONUS_WEEK_TOP     = 5;
const BONUS_WEEK_TOP_TIED = 3;

function pick(arr, i) { return arr[((i % arr.length) + arr.length) % arr.length]; }
function mkRng(seed) { let s = (seed | 0) || 1; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }
function shuffle(arr, seed) { const a = [...arr]; const rnd = mkRng(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  let body = {};
  try { body = await req.json(); } catch { /* empty body ok */ }

  const captainEmails = Array.isArray(body.captainEmails) ? body.captainEmails : [];
  const finalizedWeeks = Number.isInteger(body.finalizedWeeks) ? body.finalizedWeeks : 2;
  const sizes = Array.isArray(body.playersPerTeam) && body.playersPerTeam.length === 6
    ? body.playersPerTeam.map(n => Math.max(4, Math.min(12, n | 0)))
    : DEFAULT_SIZES;

  try {
    await wipeTestSeason(); // always start clean

    const seasonStore   = getStore('seasons');
    const teamStore     = getStore('teams');
    const scheduleStore = getStore('schedule');
    const scoresStore   = getStore('scores');
    const lineupStore   = getStore('lineups');

    const now = new Date().toISOString();
    const usedNames = new Set();

    // ── Season ────────────────────────────────────────────────
    const season = {
      id: SEASON_ID, name: 'TEST SEASON', label: 'TEST SEASON — staff QA only',
      isTest: true, status: 'open', registration: 'closed',
      startDate: '2026-06-01', endDate: '2026-07-15',
      weeks: 5, roundsPerMatch: 2, gamesPerRound: 6, maxRosterSize: 12,
      divisions: [{ id: DIVISION, name: DIV_LABEL, capacity: 6, teamPrice: 0, agentPrice: 0, stripeTeamPriceId: null, stripeAgentPriceId: null }],
      createdAt: now, updatedAt: now,
    };
    await seasonStore.set(SEASON_ID, JSON.stringify(season));

    // ── Teams + rosters ───────────────────────────────────────
    const teams = [];
    for (let t = 0; t < 6; t++) {
      const teamId = `team-test-${t + 1}`;
      const size = sizes[t];
      const nFemale = Math.floor(size / 2);
      const nMale = size - nFemale;
      const roster = [];
      for (let i = 0; i < nMale; i++)   roster.push(makePlayer('M', teamId, roster.length, usedNames));
      for (let i = 0; i < nFemale; i++) roster.push(makePlayer('F', teamId, roster.length, usedNames));

      roster[0].isCaptain = true;
      const captainEmail = (captainEmails[t] || '').toString().trim().toLowerCase()
        || `test-captain-${t + 1}@dinksociety.test`;
      roster[0].email = captainEmail;
      roster[0].normalizedEmail = captainEmail;

      const team = {
        id: teamId, name: TEAM_NAMES[t], emoji: TEAM_EMOJIS[t], isTest: true,
        seasonId: SEASON_ID, circuit: CIRCUIT, division: DIVISION, divisionLabel: DIV_LABEL,
        captain: roster[0].name, captainEmail, roster,
        createdAt: now, updatedAt: now, createdBy: admin.email,
      };
      await teamStore.setJSON(`team/${teamId}.json`, team);
      teams.push(team);
    }
    const teamsById = new Map(teams.map(t => [t.id, t]));

    // ── Round-robin schedule (circle method): 6 teams → 5 weeks ─
    const weeks = roundRobin(teams);
    const baseDate = new Date('2026-06-08T19:00:00.000Z');

    // Aggregators for direct standings / player-stats computation
    const teamAgg = new Map();
    const playerAgg = new Map();
    const weeklyPerTeam = {}; // week → { teamId: matchPoints }
    const weeklyPlayers = {}; // week → Map(pid → weekly game stats) for POW + rank movement
    const weekMeta = {};      // week → { date } for display

    let finalizedCount = 0, openCount = 0;

    // Rotate court sets across the season (A=1&2, B=3&6, C=5&7).
    const courtPlan = assignCourtSets(
      weeks.map(week => week.map(([h, a]) => ({ teamAId: h.id, teamBId: a.id })))
    );

    // Seed every lineup/scoring state so the full flow is testable:
    //   final    → played + scored (weeks 1..finalizedWeeks)
    //   revealed → both lineups locked, no scores yet (ready to score)
    //   waiting  → home locked, away not set (opponent must set; lineups hidden)
    //   future   → no lineups (both captains set from scratch)
    const weekState = (week) =>
      week <= finalizedWeeks ? 'final'
      : week === finalizedWeeks + 1 ? 'revealed'
      : week === finalizedWeeks + 2 ? 'waiting'
      : 'future';

    for (let w = 0; w < weeks.length; w++) {
      const week = w + 1;
      const pairings = weeks[w];
      const matches = [];

      for (let idx = 0; idx < pairings.length; idx++) {
        const [home, away] = pairings[idx];
        const matchId = `m_${CIRCUIT}_${DIVISION.toLowerCase()}_w${week}_${idx + 1}`;
        const scheduledAt = new Date(baseDate.getTime() + (w * 7 * 86400000)).toISOString();

        const state = weekState(week);
        const cp = courtPlan[w][idx];
        const match = {
          id: matchId,
          teamA: { id: home.id, name: home.name },
          teamB: { id: away.id, name: away.name },
          courtSet: cp.courtSet, courtA: cp.courtA, courtB: cp.courtB,
          court: `Courts ${cp.courtA} & ${cp.courtB}`,
          championship: week === weeks.length, // last test week = championship (win by 2) for QA
          venue: 'Test Courts', scheduledAt,
          scoreA: null, scoreB: null, finalizedAt: null,
        };

        // Lineups per state
        let homeLineup = null, awayLineup = null;
        if (state === 'final' || state === 'revealed') {
          homeLineup = buildLineup(home, matchId, week * 13 + idx, true);
          awayLineup = buildLineup(away, matchId, week * 13 + idx + 500, true);
          await lineupStore.setJSON(`lineup/${matchId}/${home.id}.json`, homeLineup);
          await lineupStore.setJSON(`lineup/${matchId}/${away.id}.json`, awayLineup);
        } else if (state === 'waiting') {
          // Home locked, away not set → opponent must set; reveal blocked
          homeLineup = buildLineup(home, matchId, week * 13 + idx, true);
          await lineupStore.setJSON(`lineup/${matchId}/${home.id}.json`, homeLineup);
        }
        // 'future' → no lineups written; both captains build from scratch

        if (state === 'final') {
          const sim = simulateMatch(week * 31 + idx * 7 + 3);
          await scoresStore.setJSON(`score/${matchId}.json`, buildScoreBlob(match, week, sim, now));
          match.scoreA = sim.round1.homePoints + sim.round2.homePoints;
          match.scoreB = sim.round1.awayPoints + sim.round2.awayPoints;
          match.round1 = sim.round1;
          match.round2 = sim.round2;
          match.finalizedAt = now;
          accumulateTeams(teamAgg, weeklyPerTeam, week, home, away, sim);
          accumulatePlayers(playerAgg, home, away, homeLineup, awayLineup, sim, teamsById, week, weeklyPlayers);
          if (!weekMeta[week] || new Date(scheduledAt) < new Date(weekMeta[week].date)) weekMeta[week] = { date: scheduledAt };
          finalizedCount++;
        } else {
          openCount++;
        }
        matches.push(match);
      }

      await scheduleStore.setJSON(`schedule/${CIRCUIT}/${DIVISION}/week-${week}.json`, {
        circuit: CIRCUIT, division: DIVISION, week, matches,
        isTest: true, generatedAt: now, generatedBy: admin.email,
      });
    }

    // ── Finalize aggregates → write standings + player-stats ───
    const { standings, playerStats } = await writeAggregates({
      teamAgg, playerAgg, weeklyPerTeam, weeklyPlayers, weekMeta, now,
      standingsStore: getStore('standings'),
      playerStatsStore: getStore('player-stats'),
    });

    return new Response(JSON.stringify({
      ok: true,
      seeded: {
        season: season.name, seasonId: SEASON_ID, circuit: CIRCUIT, division: DIVISION,
        teams: teams.length,
        players: teams.reduce((n, t) => n + t.roster.length, 0),
        rosterSizes: sizes, weeks: weeks.length, finalizedWeeks,
        finalizedMatches: finalizedCount, openMatches: openCount,
        rankedTeams: standings.divisions[DIVISION]?.teams.length || 0,
        rankedPlayers: Object.keys(playerStats.players).length,
      },
      captains: teams.map(t => ({ team: t.name, captainEmail: t.captainEmail })),
      viewLinks: {
        teams:       `/teams.html?season=${SEASON_ID}`,
        standings:   `/standings.html?season=${SEASON_ID}`,
        leaderboard: `/leaderboard.html?circuit=${CIRCUIT}`,
        stats:       `/leaderboard.html?circuit=${CIRCUIT}&view=players`,
      },
      note: 'Captains sign in at /captain.html. Week 1–2 are final; the next week is locked & ready to score; the following week is waiting on one team to set a lineup; the last week has no lineups set yet (build from scratch) and is the championship (win by 2).',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('admin-seed-test-season error:', err);
    return new Response(JSON.stringify({ error: 'Seed failed', detail: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

// ===== Roster / lineup builders =====

function makePlayer(gender, teamId, index, usedNames) {
  let name, guard = 0;
  do {
    const first = gender === 'M' ? pick(FIRST_M, Math.floor(Math.random() * FIRST_M.length))
                                 : pick(FIRST_F, Math.floor(Math.random() * FIRST_F.length));
    const last = pick(LAST, Math.floor(Math.random() * LAST.length));
    name = `${first} ${last}`;
  } while (usedNames.has(name) && guard++ < 60);
  usedNames.add(name);

  const num = String(index + 1).padStart(2, '0');
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}.${teamId}@dinksociety.test`;
  return {
    id: `p_test_${teamId.replace('team-test-', 't')}_${num}`,
    name, gender, email, normalizedEmail: email, phone: null, normalizedPhone: null,
    dupr: +(2.8 + Math.random() * 1.4).toFixed(2), isCaptain: false, isTest: true,
  };
}

function roundRobin(teams) {
  const n = teams.length, rot = [...teams], weeks = [];
  for (let r = 0; r < n - 1; r++) {
    const pairings = [];
    for (let i = 0; i < n / 2; i++) pairings.push([rot[i], rot[n - 1 - i]]);
    weeks.push(pairings);
    const fixed = rot[0], rest = rot.slice(1); rest.unshift(rest.pop());
    rot.splice(0, rot.length, fixed, ...rest);
  }
  return weeks;
}

/** Valid 12-slot lineup. g1 = women's (2F), g2 = men's (2M), g3-6 = mixed (1M+1F). */
function buildLineup(team, matchId, seed, locked = true) {
  const females = shuffle(team.roster.filter(p => p.gender === 'F'), seed);
  const males = shuffle(team.roster.filter(p => p.gender === 'M'), seed + 7);
  const games = {};
  let fi = 0, mi = 0;
  const nextF = () => females[(fi++) % females.length];
  const nextM = () => males[(mi++) % males.length];
  for (let round = 1; round <= 2; round++) {
    for (let g = 1; g <= 6; g++) {
      const slot = `r${round}g${g}`;
      let p1, p2;
      if (g === 1) { p1 = nextF(); p2 = nextF(); }
      else if (g === 2) { p1 = nextM(); p2 = nextM(); }
      else { p1 = nextM(); p2 = nextF(); }
      games[slot] = { p1: p1.id, p2: p2.id, p1Name: p1.name, p2Name: p2.name };
    }
  }
  const now = new Date().toISOString();
  return { matchId, teamId: team.id, teamName: team.name, games, isTest: true,
           lockedAt: locked ? now : null, lockedBy: locked ? team.captainEmail : null,
           updatedAt: now, updatedBy: team.captainEmail };
}

// ===== Match simulation =====

/** Returns per-game scores + round summaries (matches captain-score round math). */
function simulateMatch(seed) {
  const rnd = mkRng(seed);
  const games = {}; // slot → { homeScore, awayScore, homeWon }
  const tally = { 1: { h: 0, a: 0 }, 2: { h: 0, a: 0 } };
  for (let round = 1; round <= 2; round++) {
    for (let g = 1; g <= 6; g++) {
      const slot = `r${round}g${g}`;
      const homeWon = rnd() > 0.5;
      const winner = 11;
      const loser = Math.floor(rnd() * 9); // 0–8
      const homeScore = homeWon ? winner : loser;
      const awayScore = homeWon ? loser : winner;
      games[slot] = { homeScore, awayScore, homeWon };
      if (homeWon) tally[round].h++; else tally[round].a++;
    }
  }
  const pts = (r) => r.h > r.a ? { homePoints: 2, awayPoints: 0 }
                   : r.a > r.h ? { homePoints: 0, awayPoints: 2 }
                   : { homePoints: 1, awayPoints: 1 };
  const round1 = { homeGames: tally[1].h, awayGames: tally[1].a, ...pts(tally[1]), scoredGames: 6 };
  const round2 = { homeGames: tally[2].h, awayGames: tally[2].a, ...pts(tally[2]), scoredGames: 6 };
  return { games, round1, round2 };
}

/** captain-score-shaped score record: { home: <homeScore>, away: <awayScore>, by, at }. */
function buildScoreBlob(match, week, sim, now) {
  const games = {};
  for (const slot of SLOT_KEYS) {
    const g = sim.games[slot];
    games[slot] = { home: g.homeScore, away: g.awayScore, by: match.teamA.name, at: now };
  }
  return {
    matchId: match.id, circuit: CIRCUIT, division: DIVISION, week,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
    games, isTest: true,
    homeSubmittedAt: now, homeSubmittedBy: match.teamA.name,
    awaySubmittedAt: now, awaySubmittedBy: match.teamB.name,
    finalizedAt: now, createdAt: now, updatedAt: now,
  };
}

// ===== Aggregation (mirrors lib/standings.js, minus the broken game guard) =====

function ensureTeam(map, team, division) {
  if (!map.has(team.id)) {
    map.set(team.id, {
      teamId: team.id, teamName: team.name, division,
      matchesPlayed: 0, wins: 0, losses: 0, ties: 0,
      matchPointsFor: 0, matchPointsAgainst: 0, sweeps: 0,
      totalGamesWon: 0, totalGamesLost: 0, weeklyBonusPoints: 0, headToHead: {},
    });
  }
  return map.get(team.id);
}

function accumulateTeams(teamAgg, weeklyPerTeam, week, home, away, sim) {
  const a = ensureTeam(teamAgg, home, DIVISION);
  const b = ensureTeam(teamAgg, away, DIVISION);
  const mpA = sim.round1.homePoints + sim.round2.homePoints;
  const mpB = sim.round1.awayPoints + sim.round2.awayPoints;

  a.matchesPlayed++; b.matchesPlayed++;
  a.matchPointsFor += mpA; a.matchPointsAgainst += mpB;
  b.matchPointsFor += mpB; b.matchPointsAgainst += mpA;

  if (!a.headToHead[b.teamId]) a.headToHead[b.teamId] = { for: 0, against: 0 };
  if (!b.headToHead[a.teamId]) b.headToHead[a.teamId] = { for: 0, against: 0 };
  a.headToHead[b.teamId].for += mpA; a.headToHead[b.teamId].against += mpB;
  b.headToHead[a.teamId].for += mpB; b.headToHead[a.teamId].against += mpA;

  const aGames = sim.round1.homeGames + sim.round2.homeGames;
  const bGames = sim.round1.awayGames + sim.round2.awayGames;
  a.totalGamesWon += aGames; a.totalGamesLost += bGames;
  b.totalGamesWon += bGames; b.totalGamesLost += aGames;

  if (mpA > mpB) { a.wins++; b.losses++; a.weeklyBonusPoints += BONUS_MATCH_WIN; }
  else if (mpB > mpA) { b.wins++; a.losses++; b.weeklyBonusPoints += BONUS_MATCH_WIN; }
  else { a.ties++; b.ties++; a.weeklyBonusPoints += BONUS_MATCH_TIE; b.weeklyBonusPoints += BONUS_MATCH_TIE; }

  if (mpA === 4 && mpB === 0) { a.sweeps++; a.weeklyBonusPoints += BONUS_SWEEP_EXTRA; }
  else if (mpB === 4 && mpA === 0) { b.sweeps++; b.weeklyBonusPoints += BONUS_SWEEP_EXTRA; }

  if (!weeklyPerTeam[week]) weeklyPerTeam[week] = {};
  weeklyPerTeam[week][a.teamId] = (weeklyPerTeam[week][a.teamId] || 0) + mpA;
  weeklyPerTeam[week][b.teamId] = (weeklyPerTeam[week][b.teamId] || 0) + mpB;
}

function ensurePlayer(map, pid, player, team) {
  if (!map.has(pid)) {
    map.set(pid, {
      playerId: pid, name: player.name, gender: player.gender || null,
      teamId: team.id, teamName: team.name,
      gamesPlayed: 0, gamesWon: 0, gamesLost: 0,
      byType: { womens: { played: 0, won: 0 }, mens: { played: 0, won: 0 }, mixed: { played: 0, won: 0 } },
      matchesPlayed: 0, ps: 0, pa: 0, diff: 0, gameDiffs: [],
      clutchW: 0, clutchG: 0, composite: null, partners: {},
    });
  }
  return map.get(pid);
}

function bumpPlayer(map, player, team, slotType, won, partnerIds, myScore, oppScore) {
  const p = ensurePlayer(map, player.id, player, team);
  p.gamesPlayed++;
  if (won) p.gamesWon++; else p.gamesLost++;
  p.byType[slotType].played++;
  if (won) p.byType[slotType].won++;
  const d = myScore - oppScore;
  p.ps += myScore; p.pa += oppScore; p.diff += d; p.gameDiffs.push(d);
  if (Math.abs(d) <= 3) { p.clutchG++; if (won) p.clutchW++; }
  for (const partnerId of partnerIds) {
    if (!p.partners[partnerId]) p.partners[partnerId] = { played: 0, won: 0 };
    p.partners[partnerId].played++;
    if (won) p.partners[partnerId].won++;
  }
}

function accumulatePlayers(playerAgg, home, away, homeLineup, awayLineup, sim, teamsById, week, weeklyPlayers) {
  const rosterH = new Map(home.roster.map(p => [p.id, p]));
  const rosterA = new Map(away.roster.map(p => [p.id, p]));

  for (const slot of SLOT_KEYS) {
    const g = sim.games[slot];
    const slotType = SLOT_TYPE[slot];
    const hp = homeLineup.games[slot];
    const ap = awayLineup.games[slot];
    if (!hp || !ap) continue;

    const homeIds = [hp.p1, hp.p2].filter(Boolean);
    const awayIds = [ap.p1, ap.p2].filter(Boolean);

    for (const pid of homeIds) {
      const player = rosterH.get(pid); if (!player) continue;
      bumpPlayer(playerAgg, player, home, slotType, g.homeWon, homeIds.filter(x => x !== pid), g.homeScore, g.awayScore);
      if (weeklyPlayers) bumpWeeklyPlayer(weeklyPlayers, week, pid, player, home, g.homeWon, g.homeScore, g.awayScore);
    }
    for (const pid of awayIds) {
      const player = rosterA.get(pid); if (!player) continue;
      bumpPlayer(playerAgg, player, away, slotType, !g.homeWon, awayIds.filter(x => x !== pid), g.awayScore, g.homeScore);
      if (weeklyPlayers) bumpWeeklyPlayer(weeklyPlayers, week, pid, player, away, !g.homeWon, g.awayScore, g.homeScore);
    }
  }

  // matchesPlayed: distinct players appearing in each team's lineup
  const seen = (lineup, roster, team) => {
    const ids = new Set();
    for (const slot of SLOT_KEYS) {
      const gp = lineup.games[slot];
      if (gp?.p1) ids.add(gp.p1);
      if (gp?.p2) ids.add(gp.p2);
    }
    for (const pid of ids) {
      const player = roster.get(pid); if (!player) continue;
      ensurePlayer(playerAgg, pid, player, team).matchesPlayed++;
    }
  };
  seen(homeLineup, rosterH, home);
  seen(awayLineup, rosterA, away);
}

function standingsComparator(a, b) {
  if (b.matchPointsFor !== a.matchPointsFor) return b.matchPointsFor - a.matchPointsFor;
  if (b.totalGamesWon !== a.totalGamesWon) return b.totalGamesWon - a.totalGamesWon;
  const aVsB = a.headToHead[b.teamId], bVsA = b.headToHead[a.teamId];
  if (aVsB && bVsA && aVsB.for !== bVsA.for) return bVsA.for - aVsB.for;
  return (b.matchPointsFor - b.matchPointsAgainst) - (a.matchPointsFor - a.matchPointsAgainst);
}

async function writeAggregates({ teamAgg, playerAgg, weeklyPerTeam, weeklyPlayers = {}, weekMeta = {}, now, standingsStore, playerStatsStore }) {
  // Weekly top-team bonus
  const weeklyTopTeams = {};
  for (const [week, perTeam] of Object.entries(weeklyPerTeam)) {
    const top = Math.max(...Object.values(perTeam));
    const winners = Object.entries(perTeam).filter(([, p]) => p === top).map(([id]) => id);
    weeklyTopTeams[week] = winners;
    const bonus = winners.length === 1 ? BONUS_WEEK_TOP : BONUS_WEEK_TOP_TIED;
    for (const id of winners) { const t = teamAgg.get(id); if (t) t.weeklyBonusPoints += bonus; }
  }

  const teams = Array.from(teamAgg.values()).sort(standingsComparator);
  teams.forEach((t, i) => {
    t.rank = i + 1;
    t.placementBonus = PLACEMENT_BONUS[i] ?? 0;
    t.societyCircuitPoints = t.weeklyBonusPoints + t.placementBonus;
  });

  const standings = {
    circuit: CIRCUIT, lastUpdated: now,
    divisions: { [DIVISION]: { teams, weeklyTopTeams } },
  };

  // Composite score (Aloha formula — mirrors lib/standings.js)
  const active = Array.from(playerAgg.values()).filter(p => p.gamesPlayed > 0);
  const maxGames = Math.max(1, ...active.map(p => p.gamesPlayed));
  for (const p of playerAgg.values()) {
    if (p.gamesPlayed === 0) { p.composite = null; continue; }
    const winPct = p.gamesWon / p.gamesPlayed;
    const avgDiff = p.diff / p.gamesPlayed;
    const volume = p.gamesPlayed / maxGames;
    const clutchPct = p.clutchG > 0 ? p.clutchW / p.clutchG : winPct;
    let consistency = 1;
    if (p.gameDiffs.length >= 2) {
      const mean = p.gameDiffs.reduce((s, d) => s + d, 0) / p.gameDiffs.length;
      const variance = p.gameDiffs.reduce((s, d) => s + (d - mean) ** 2, 0) / p.gameDiffs.length;
      consistency = Math.max(0, 1 - (Math.sqrt(variance) / 8));
    }
    p.composite = (winPct * 60) + (clutchPct * 10) + ((avgDiff / 11) * 15) + (consistency * 5) + (volume * 10);
    p.clutchPct = clutchPct;
    p.consistency = consistency;
  }

  // Weekly Player of the Week (gender-split, by that week's DSR) + rank movement (+/-)
  standings.weeklyTopPerformers = buildWeeklyTopPerformers(weeklyPlayers, weekMeta);
  const rankDeltas = computeRankDeltas(weeklyPlayers);
  for (const p of playerAgg.values()) {
    p.rankDelta = Object.prototype.hasOwnProperty.call(rankDeltas, p.playerId) ? rankDeltas[p.playerId] : null;
  }

  const playerStats = { circuit: CIRCUIT, lastUpdated: now, players: Object.fromEntries(playerAgg) };

  await Promise.all([
    standingsStore.setJSON(`standings/${CIRCUIT}.json`, standings),
    playerStatsStore.setJSON(`player-stats/${CIRCUIT}.json`, playerStats),
  ]);

  return { standings, playerStats };
}

// ════════════════════════════════════════════════════════════════════
// Weekly DSR · Player of the Week (gender-split) · rank movement (+/-)
// (mirrors lib/standings.js)
// ════════════════════════════════════════════════════════════════════

function compositeScore(p, maxGames) {
  if (!p.gamesPlayed) return null;
  const winPct = p.gamesWon / p.gamesPlayed;
  const avgDiff = p.diff / p.gamesPlayed;
  const volume = p.gamesPlayed / maxGames;
  const clutchPct = p.clutchG > 0 ? p.clutchW / p.clutchG : winPct;
  let consistency = 1;
  if (p.gameDiffs.length >= 2) {
    const mean = p.gameDiffs.reduce((s, d) => s + d, 0) / p.gameDiffs.length;
    const variance = p.gameDiffs.reduce((s, d) => s + (d - mean) ** 2, 0) / p.gameDiffs.length;
    consistency = Math.max(0, 1 - (Math.sqrt(variance) / 8));
  }
  return (winPct * 60) + (clutchPct * 10) + ((avgDiff / 11) * 15) + (consistency * 5) + (volume * 10);
}

function normGender(g) { const s = String(g || '').trim().toLowerCase(); return s[0] === 'f' ? 'F' : s[0] === 'm' ? 'M' : ''; }

function ensureWeeklyPlayer(weekly, week, pid, player, team) {
  if (!weekly[week]) weekly[week] = new Map();
  const m = weekly[week];
  if (!m.has(pid)) m.set(pid, {
    playerId: pid, name: player.name, gender: player.gender || null,
    teamId: team?.id || null, teamName: team?.name || null,
    gamesPlayed: 0, gamesWon: 0, gamesLost: 0, diff: 0, gameDiffs: [], clutchW: 0, clutchG: 0,
  });
  return m.get(pid);
}

function bumpWeeklyPlayer(weekly, week, pid, player, team, won, myScore, oppScore) {
  if (week == null) return;
  const p = ensureWeeklyPlayer(weekly, week, pid, player, team);
  p.gamesPlayed++; if (won) p.gamesWon++; else p.gamesLost++;
  if (Number.isInteger(myScore) && Number.isInteger(oppScore)) {
    const d = myScore - oppScore; p.diff += d; p.gameDiffs.push(d);
    if (Math.abs(d) <= 3) { p.clutchG++; if (won) p.clutchW++; }
  }
}

function buildWeeklyTopPerformers(weekly, weekMeta = {}) {
  const out = [];
  const weeks = Object.keys(weekly).map(Number).sort((a, b) => a - b);
  for (const wk of weeks) {
    const players = Array.from(weekly[wk].values()).filter(p => p.gamesPlayed > 0);
    if (!players.length) continue;
    const maxGames = Math.max(1, ...players.map(p => p.gamesPlayed));
    players.forEach(p => { p._wdsr = compositeScore(p, maxGames); });
    const topN = g => players.filter(p => normGender(p.gender) === g)
      .sort((a, b) => (b._wdsr - a._wdsr) || (b.diff - a.diff))
      .slice(0, 3)
      .map(p => ({ playerId: p.playerId, name: p.name, teamName: p.teamName, teamId: p.teamId,
        gender: p.gender, dsr: Math.round(p._wdsr * 10) / 10, w: p.gamesWon, l: p.gamesLost, diff: p.diff }));
    out.push({ week: wk, label: `Week ${wk}`, date: weekMeta[wk]?.date || null, men: topN('M'), women: topN('F') });
  }
  return out.sort((a, b) => b.week - a.week);
}

function computeRankDeltas(weekly) {
  const weeks = Object.keys(weekly).map(Number).sort((a, b) => a - b);
  const cum = new Map();
  const snaps = [];
  for (const wk of weeks) {
    for (const [pid, w] of weekly[wk]) {
      if (!cum.has(pid)) cum.set(pid, { gamesPlayed: 0, gamesWon: 0, diff: 0, gameDiffs: [], clutchW: 0, clutchG: 0 });
      const c = cum.get(pid);
      c.gamesPlayed += w.gamesPlayed; c.gamesWon += w.gamesWon; c.diff += w.diff;
      for (const d of w.gameDiffs) c.gameDiffs.push(d);
      c.clutchW += w.clutchW; c.clutchG += w.clutchG;
    }
    const active = [...cum.entries()].filter(([, c]) => c.gamesPlayed > 0);
    const maxGames = Math.max(1, ...active.map(([, c]) => c.gamesPlayed));
    const ranked = active.map(([pid, c]) => ({ pid, s: compositeScore(c, maxGames) })).sort((a, b) => b.s - a.s);
    const snap = new Map(); ranked.forEach((r, i) => snap.set(r.pid, i + 1));
    snaps.push(snap);
  }
  const cur = snaps[snaps.length - 1] || new Map();
  const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : new Map();
  const deltas = {};
  for (const [pid, rank] of cur) {
    const pr = prev.get(pid);
    deltas[pid] = (pr == null) ? null : (pr - rank);
  }
  return deltas;
}

export const config = { path: '/.netlify/functions/admin-seed-test-season' };

// Exported for unit testing only (not used by the Netlify handler path).
export const __test = {
  roundRobin, buildLineup, simulateMatch, buildScoreBlob, makePlayer,
  accumulateTeams, accumulatePlayers, writeAggregates,
  SLOT_KEYS, SLOT_TYPE, DIVISION, CIRCUIT,
};
