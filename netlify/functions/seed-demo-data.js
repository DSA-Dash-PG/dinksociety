// =============================================================
// POST /api/seed-demo-data
//
// Seeds a complete DEMO season with realistic data:
//   - 1 demo season (circuit-demo) with 2 divisions
//   - 6 teams per division with full rosters (6 players each)
//   - 6 weeks of round-robin matches with scores
//   - Standings computed from results
//   - Confirmed registrations + a few free agents
//   - Leaderboard entries
//
// EVERYTHING is keyed under the demo identity (circuit-demo / DEMO / demo-*
// divisions / team-demo- teams / lb-demo- / reg-demo-) and tagged isTest:true,
// so it never collides with the real Circuit I (circuit-i) and can be removed
// in one shot by admin-wipe-demo-data.js.
//
// Deterministic + idempotent: a fixed RNG seed means re-running produces the
// SAME data, and we wipe only the prior demo payload before reseeding (no
// broad resets).
//
// Admin-only.
// =============================================================

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { DEMO, wipeDemoData } from './lib/demo-data.js';
import { guardSeedRun } from './lib/seed-lock.js';

// ── Deterministic RNG (linear congruential) ──────────────────
const SEED = 20260621;
function mkRng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }
function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(arr, rng) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const FIRST_NAMES_M = ['Marcus', 'Devon', 'James', 'Tyler', 'Chris', 'Jordan', 'Alex', 'Blake', 'Ryan', 'Kai', 'Sam', 'Drew', 'Cole', 'Nate', 'Jalen', 'Derek', 'Omar', 'Ravi', 'Leo', 'Trent'];
const FIRST_NAMES_F = ['Saya', 'Priya', 'Mia', 'Ana', 'Casey', 'Morgan', 'Dana', 'Avery', 'Quinn', 'Riley', 'Nina', 'Jade', 'Luna', 'Zoe', 'Emi', 'Tara', 'Dani', 'Skye', 'Val', 'Kira'];
const LAST_NAMES = ['Thompson', 'Kim', 'Rodriguez', 'Chen', 'Williams', 'Patel', 'Davis', 'Martinez', 'Lee', 'Brown', 'Taylor', 'Anderson', 'Wilson', 'Moore', 'Jackson', 'Harris', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'Allen', 'King', 'Wright'];

const TEAM_NAMES_30 = ['Net Gains', 'Kitchen Nightmares', 'Dink Floyd', 'Lob City', 'Paddle Royale', 'Zero Zero Two'];
const TEAM_NAMES_35 = ['Drop Shot Mafia', 'The Third Shot', 'Erne & Burn', 'Court Jesters', 'Volley Llamas', 'Smash Mouth'];
const TEAM_EMOJIS = ['🏆', '🔥', '🎸', '🏙️', '👑', '🎯', '💀', '⚡', '🦙', '🃏', '🦈', '💥'];

const SEASON_ID = DEMO.SEASON_ID;        // 'circuit-demo'
const DIV_30 = DEMO.DIVISIONS[0];        // { id:'demo-3-0-mixed', short:'30' }
const DIV_35 = DEMO.DIVISIONS[1];        // { id:'demo-3-5-mixed', short:'35' }

function makePlayer(gender, rng, usedNames, teamShort, idx) {
  let name, guard = 0;
  do {
    name = `${pick(gender === 'male' ? FIRST_NAMES_M : FIRST_NAMES_F, rng)} ${pick(LAST_NAMES, rng)}`;
  } while (usedNames.has(name) && guard++ < 80);
  usedNames.add(name);

  const age = 22 + Math.floor(rng() * 18);
  const dupr = (2.5 + rng() * 2).toFixed(2);
  return {
    id: `p-demo-${teamShort}-${String(idx).padStart(2, '0')}`,
    name, gender,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}.${teamShort}@demo.dinksociety.test`,
    dob: `${2026 - age}-${String(Math.floor(rng() * 12) + 1).padStart(2, '0')}-${String(Math.floor(rng() * 28) + 1).padStart(2, '0')}`,
    dupr, age, isTest: true,
  };
}

function generateTeams(teamNames, div, rng, usedNames, emojiOffset) {
  return teamNames.map((name, i) => {
    const teamShort = `${div.short}-${i + 1}`;
    let n = 0;
    const males = Array.from({ length: 3 }, () => makePlayer('male', rng, usedNames, teamShort, ++n));
    const females = Array.from({ length: 3 }, () => makePlayer('female', rng, usedNames, teamShort, ++n));
    const roster = [...males, ...females];
    roster[0].role = 'captain';
    return {
      id: `${DEMO.TEAM_PREFIX}${teamShort}`,           // e.g. team-demo-30-1
      name, emoji: TEAM_EMOJIS[(emojiOffset + i) % TEAM_EMOJIS.length] || '🏓',
      division: div.id, divisionLabel: div.name,
      seasonId: SEASON_ID, circuit: DEMO.CIRCUIT, isTest: true,
      captain: roster[0].name, captainEmail: roster[0].email,
      roster,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
  });
}

function generateRoundRobin(teams, rng) {
  const matchups = [];
  for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) matchups.push([i, j]);
  const shuffled = shuffle(matchups, rng);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const weekMatchups = [];
    for (let m = 0; m < 3; m++) weekMatchups.push(shuffled[(w * 3 + m) % shuffled.length]);
    weeks.push(weekMatchups);
  }
  return weeks;
}

function simulateMatch(rng) {
  const rounds = [{ homeWins: 0, awayWins: 0 }, { homeWins: 0, awayWins: 0 }];
  const games = [];
  for (let r = 0; r < 2; r++) {
    for (let g = 0; g < 6; g++) {
      const homeWon = rng() > 0.5;
      const loser = Math.floor(rng() * 9); // 0–8
      const finalHome = homeWon ? 11 : loser;
      const finalAway = homeWon ? loser : 11;
      games.push({ round: r + 1, game: g + 1, home: finalHome, away: finalAway });
      if (finalHome > finalAway) rounds[r].homeWins++; else rounds[r].awayWins++;
    }
  }
  let homeRoundPts = 0, awayRoundPts = 0;
  for (const r of rounds) {
    if (r.homeWins > r.awayWins) homeRoundPts += 2;
    else if (r.awayWins > r.homeWins) awayRoundPts += 2;
    else { homeRoundPts += 1; awayRoundPts += 1; }
  }
  const totalHomeWins = games.filter(g => g.home > g.away).length;
  const totalAwayWins = games.filter(g => g.away > g.home).length;
  return {
    games, homeRoundPts, awayRoundPts,
    homeGameWins: totalHomeWins, awayGameWins: totalAwayWins,
    homePD: games.reduce((s, g) => s + (g.home - g.away), 0),
    awayPD: games.reduce((s, g) => s + (g.away - g.home), 0),
  };
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  // Cooldown: stop accidental rapid reseeds.
  const guard = await guardSeedRun('demo-seed', 15000);
  if (!guard.ok) {
    return new Response(JSON.stringify({ error: 'Seeded too recently — please wait a moment.', retryInMs: guard.retryInMs }),
      { status: 429, headers: { 'Content-Type': 'application/json' } });
  }

  // Idempotent: clear ONLY the prior demo payload, then reseed deterministically.
  await wipeDemoData();

  const rng = mkRng(SEED);
  const seasonStore = getStore('seasons');
  const teamStore = getStore('teams');
  const matchStore = getStore('matches');
  const standingsStore = getStore('standings');
  const regStore = getStore('registrations');
  const lbStore = getStore('leaderboard');

  const usedNames = new Set();
  const now = new Date().toISOString();

  // ── Season ──
  const season = {
    id: SEASON_ID, name: 'Circuit Demo', label: 'Circuit Demo (sample data)',
    isTest: true, status: 'open', registration: 'closed',
    startDate: '2026-05-06', endDate: '2026-06-24',
    divisions: [
      { id: DIV_30.id, name: DIV_30.name, capacity: 6, teamPrice: 450, agentPrice: 75, stripeTeamPriceId: null, stripeAgentPriceId: null },
      { id: DIV_35.id, name: DIV_35.name, capacity: 6, teamPrice: 450, agentPrice: 75, stripeTeamPriceId: null, stripeAgentPriceId: null },
    ],
    createdAt: now, updatedAt: now,
  };
  await seasonStore.set(season.id, JSON.stringify(season));

  // ── Teams ──
  const teams30 = generateTeams(TEAM_NAMES_30, DIV_30, rng, usedNames, 0);
  const teams35 = generateTeams(TEAM_NAMES_35, DIV_35, rng, usedNames, 6);
  const allTeams = [...teams30, ...teams35];
  for (const team of allTeams) await teamStore.set(team.id, JSON.stringify(team));

  // ── Matches & Standings ──
  const matchDates = ['2026-05-06', '2026-05-13', '2026-05-20', '2026-05-27', '2026-06-03', '2026-06-10'];
  let matchCount = 0;

  for (const [divTeams, div] of [[teams30, DIV_30], [teams35, DIV_35]]) {
    const weeks = generateRoundRobin(divTeams, rng);
    const standings = {};
    for (const t of divTeams) standings[t.id] = { teamId: t.id, teamName: t.name, w: 0, l: 0, t: 0, pts: 0, gw: 0, gl: 0, pd: 0 };

    for (let w = 0; w < 6; w++) {
      let mi = 0;
      for (const [hi, ai] of weeks[w]) {
        const home = divTeams[hi], away = divTeams[ai];
        const result = simulateMatch(rng);
        const match = {
          id: `match-demo-${div.short}-w${w + 1}-${++mi}`,
          seasonId: SEASON_ID, circuit: DEMO.CIRCUIT, isTest: true,
          division: div.id, divisionLabel: div.name,
          week: w + 1, date: matchDates[w],
          homeTeamId: home.id, homeTeamName: home.name,
          awayTeamId: away.id, awayTeamName: away.name,
          status: 'final',
          homeRoundPts: result.homeRoundPts, awayRoundPts: result.awayRoundPts,
          homeGameWins: result.homeGameWins, awayGameWins: result.awayGameWins,
          homePD: result.homePD, awayPD: result.awayPD,
          games: result.games, submittedAt: now,
        };
        await matchStore.set(match.id, JSON.stringify(match));
        matchCount++;

        const hs = standings[home.id], as = standings[away.id];
        hs.pts += result.homeRoundPts; as.pts += result.awayRoundPts;
        hs.gw += result.homeGameWins; hs.gl += result.awayGameWins;
        as.gw += result.awayGameWins; as.gl += result.homeGameWins;
        hs.pd += result.homePD; as.pd += result.awayPD;
        if (result.homeRoundPts > result.awayRoundPts) { hs.w++; as.l++; }
        else if (result.awayRoundPts > result.homeRoundPts) { as.w++; hs.l++; }
        else { hs.t++; as.t++; }
      }
    }

    const sorted = Object.values(standings).sort((a, b) =>
      (b.pts - a.pts) || (b.pd - a.pd) || (b.gw - a.gw));

    await standingsStore.set(`${SEASON_ID}:${div.id}`, JSON.stringify({
      seasonId: SEASON_ID, division: div.id, divisionLabel: div.name,
      isTest: true, standings: sorted, updatedAt: now,
    }));

    // ── Leaderboard entries ──
    const circuitPoints = [100, 75, 50, 30, 15, 15];
    for (let i = 0; i < sorted.length; i++) {
      const team = divTeams.find(t => t.id === sorted[i].teamId);
      if (!team) continue;
      for (const player of team.roster) {
        const entry = {
          id: `lb-demo-${player.id}`,
          playerId: player.id, playerName: player.name, teamName: team.name,
          division: div.id, divisionLabel: div.name,
          seasonId: SEASON_ID, isTest: true,
          circuitPoints: circuitPoints[i] || 10, placement: i + 1, updatedAt: now,
        };
        await lbStore.set(entry.id, JSON.stringify(entry));
      }
    }
  }

  // ── Registrations (team) ──
  let regN = 0;
  for (const team of allTeams) {
    const reg = {
      id: `reg-demo-${++regN}`,
      seasonId: SEASON_ID, circuit: 'Circuit Demo', isTest: true,
      division: team.division, divisionLabel: team.divisionLabel,
      path: 'team', status: 'confirmed', price: 450,
      team: { name: team.name, captain: team.captain, players: [team.roster[0]] },
      createdAt: now, confirmedAt: now, amountPaid: 450,
    };
    await regStore.set(reg.id, JSON.stringify(reg));
  }

  // ── Free agent registrations ──
  for (let i = 0; i < 4; i++) {
    const gender = i % 2 === 0 ? 'male' : 'female';
    const div = i < 2 ? DIV_30 : DIV_35;
    const player = makePlayer(gender, rng, usedNames, `agent-${div.short}`, i + 1);
    const reg = {
      id: `reg-demo-agent-${i + 1}`,
      seasonId: SEASON_ID, circuit: 'Circuit Demo', isTest: true,
      division: div.id, divisionLabel: div.name,
      path: 'agent', status: 'confirmed', price: 75,
      agent: { name: player.name, email: player.email, gender: player.gender, dupr: player.dupr },
      createdAt: now, confirmedAt: now, amountPaid: 75,
    };
    await regStore.set(reg.id, JSON.stringify(reg));
  }

  return new Response(JSON.stringify({
    ok: true,
    seeded: {
      seasonId: SEASON_ID, season: season.name, divisions: 2,
      teams: allTeams.length,
      players: allTeams.reduce((n, t) => n + t.roster.length, 0),
      matches: matchCount, registrations: allTeams.length + 4,
    },
    note: 'Demo data is tagged isTest and lives under circuit-demo. View at /teams.html?season=circuit-demo. Remove with admin-wipe-demo-data.',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/.netlify/functions/seed-demo-data' };
