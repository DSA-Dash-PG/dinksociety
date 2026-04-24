// =============================================================
// POST /api/seed-demo-data
//
// Seeds a complete mock season with realistic data:
//   - 1 season (Circuit I) with 2 divisions
//   - 6 teams per division with full rosters (6 players each)
//   - 6 weeks of round-robin matches with scores
//   - Standings computed from results
//   - 10 confirmed registrations
//   - Leaderboard entries
//
// Idempotent: call it again to reset everything.
// Admin-only endpoint.
// =============================================================

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import crypto from 'crypto';

function rid() { return crypto.randomBytes(6).toString('hex'); }

const FIRST_NAMES_M = ['Marcus', 'Devon', 'James', 'Tyler', 'Chris', 'Jordan', 'Alex', 'Blake', 'Ryan', 'Kai', 'Sam', 'Drew', 'Cole', 'Nate', 'Jalen', 'Derek', 'Omar', 'Ravi', 'Leo', 'Trent'];
const FIRST_NAMES_F = ['Saya', 'Priya', 'Mia', 'Ana', 'Casey', 'Morgan', 'Dana', 'Avery', 'Quinn', 'Riley', 'Nina', 'Jade', 'Luna', 'Zoe', 'Emi', 'Tara', 'Dani', 'Skye', 'Val', 'Kira'];
const LAST_NAMES = ['Thompson', 'Kim', 'Rodriguez', 'Chen', 'Williams', 'Patel', 'Davis', 'Martinez', 'Lee', 'Brown', 'Taylor', 'Anderson', 'Wilson', 'Moore', 'Jackson', 'Harris', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'Allen', 'King', 'Wright'];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function makePlayer(gender, usedNames) {
  let name;
  do {
    const first = pickRandom(gender === 'male' ? FIRST_NAMES_M : FIRST_NAMES_F);
    const last = pickRandom(LAST_NAMES);
    name = `${first} ${last}`;
  } while (usedNames.has(name));
  usedNames.add(name);

  const age = 22 + Math.floor(Math.random() * 18);
  const dupr = (2.5 + Math.random() * 2).toFixed(2);
  return {
    id: rid(),
    name,
    gender,
    email: name.toLowerCase().replace(/\s+/g, '.') + '@example.com',
    dob: `${2026 - age}-${String(Math.floor(Math.random()*12)+1).padStart(2,'0')}-${String(Math.floor(Math.random()*28)+1).padStart(2,'0')}`,
    dupr,
    age,
  };
}

const TEAM_NAMES_30 = ['Net Gains', 'Kitchen Nightmares', 'Dink Floyd', 'Lob City', 'Paddle Royale', 'Zero Zero Two'];
const TEAM_NAMES_35 = ['Drop Shot Mafia', 'The Third Shot', 'Erne & Burn', 'Court Jesters', 'Volley Llamas', 'Smash Mouth'];
const TEAM_EMOJIS = ['🏆', '🔥', '🎸', '🏙️', '👑', '🎯', '💀', '⚡', '🦙', '🃏', '🦈', '💥'];

function generateTeams(teamNames, divisionId, usedNames) {
  return teamNames.map((name, i) => {
    const males = Array.from({length: 3}, () => makePlayer('male', usedNames));
    const females = Array.from({length: 3}, () => makePlayer('female', usedNames));
    const roster = [...males, ...females];
    roster[0].role = 'captain';

    return {
      id: `team-${divisionId}-${i + 1}`,
      name,
      emoji: TEAM_EMOJIS[i] || '🏓',
      division: divisionId,
      seasonId: 'circuit-i',
      captain: roster[0].name,
      captainEmail: roster[0].email,
      roster,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });
}

function generateRoundRobin(teams) {
  // 6 teams → 15 unique matchups, we play 3 per week = 5 weeks
  // Then repeat first 3 for week 6
  const matchups = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      matchups.push([i, j]);
    }
  }
  const shuffled = shuffle(matchups);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const weekMatchups = [];
    for (let m = 0; m < 3; m++) {
      const idx = (w * 3 + m) % shuffled.length;
      weekMatchups.push(shuffled[idx]);
    }
    weeks.push(weekMatchups);
  }
  return weeks;
}

function simulateMatch(homeTeam, awayTeam) {
  // Simulate 2 rounds of 6 games each
  const rounds = [{ homeWins: 0, awayWins: 0 }, { homeWins: 0, awayWins: 0 }];
  const games = [];

  for (let r = 0; r < 2; r++) {
    for (let g = 0; g < 6; g++) {
      const homeScore = 7 + Math.floor(Math.random() * 5); // 7-11
      const diff = Math.random() > 0.3 ? -(1 + Math.floor(Math.random() * 5)) : (1 + Math.floor(Math.random() * 3));
      let awayScore = homeScore + diff;
      // One team must reach 11
      if (homeScore < 11 && awayScore < 11) {
        if (Math.random() > 0.5) { awayScore = 11; } else { /* homeScore stays, but we need 11 */ }
      }
      const finalHome = Math.max(homeScore, Math.random() > 0.5 ? 11 : homeScore);
      const finalAway = finalHome === 11 ? Math.min(awayScore, 9 + Math.floor(Math.random() * 2)) : 11;

      games.push({ round: r + 1, game: g + 1, home: finalHome, away: finalAway });
      if (finalHome > finalAway) rounds[r].homeWins++;
      else rounds[r].awayWins++;
    }
  }

  // Calculate round points
  let homeRoundPts = 0, awayRoundPts = 0;
  for (const r of rounds) {
    if (r.homeWins > r.awayWins) { homeRoundPts += 2; }
    else if (r.awayWins > r.homeWins) { awayRoundPts += 2; }
    else { homeRoundPts += 1; awayRoundPts += 1; }
  }

  const totalHomeWins = games.filter(g => g.home > g.away).length;
  const totalAwayWins = games.filter(g => g.away > g.home).length;

  return {
    games,
    homeRoundPts,
    awayRoundPts,
    homeGameWins: totalHomeWins,
    awayGameWins: totalAwayWins,
    homePD: games.reduce((sum, g) => sum + (g.home - g.away), 0),
    awayPD: games.reduce((sum, g) => sum + (g.away - g.home), 0),
  };
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try { await requireAdmin(req); } catch { return unauthResponse(); }

  const seasonStore = getStore('seasons');
  const teamStore = getStore('teams');
  const matchStore = getStore('matches');
  const standingsStore = getStore('standings');
  const regStore = getStore('registrations');
  const lbStore = getStore('leaderboard');

  const usedNames = new Set();

  // ── Season ──
  const season = {
    id: 'circuit-i',
    name: 'Circuit I',
    label: 'Circuit I (May 2026)',
    status: 'open',
    registration: 'closed', // season in progress
    startDate: '2026-05-06',
    endDate: '2026-06-24',
    divisions: [
      { id: '3-0-mixed', name: '3.0 Mixed', capacity: 6, teamPrice: 450, agentPrice: 75, stripeTeamPriceId: null, stripeAgentPriceId: null },
      { id: '3-5-mixed', name: '3.5 Mixed', capacity: 6, teamPrice: 450, agentPrice: 75, stripeTeamPriceId: null, stripeAgentPriceId: null },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await seasonStore.set(season.id, JSON.stringify(season));

  // ── Teams ──
  const teams30 = generateTeams(TEAM_NAMES_30, '3-0-mixed', usedNames);
  const teams35 = generateTeams(TEAM_NAMES_35, '3-5-mixed', usedNames);
  const allTeams = [...teams30, ...teams35];

  for (const team of allTeams) {
    await teamStore.set(team.id, JSON.stringify(team));
  }

  // ── Matches & Standings ──
  const matchDates = ['2026-05-06', '2026-05-13', '2026-05-20', '2026-05-27', '2026-06-03', '2026-06-10'];

  for (const [divTeams, divId, divLabel] of [[teams30, '3-0-mixed', '3.0 Mixed'], [teams35, '3-5-mixed', '3.5 Mixed']]) {
    const weeks = generateRoundRobin(divTeams);
    const standings = {};

    // Init standings
    for (const t of divTeams) {
      standings[t.id] = { teamId: t.id, teamName: t.name, w: 0, l: 0, t: 0, pts: 0, gw: 0, gl: 0, pd: 0 };
    }

    for (let w = 0; w < 6; w++) {
      for (const [hi, ai] of weeks[w]) {
        const home = divTeams[hi];
        const away = divTeams[ai];
        const result = simulateMatch(home, away);

        const match = {
          id: `match-${divId}-w${w+1}-${rid()}`,
          seasonId: 'circuit-i',
          division: divId,
          divisionLabel: divLabel,
          week: w + 1,
          date: matchDates[w],
          homeTeamId: home.id,
          homeTeamName: home.name,
          awayTeamId: away.id,
          awayTeamName: away.name,
          status: 'final',
          homeRoundPts: result.homeRoundPts,
          awayRoundPts: result.awayRoundPts,
          homeGameWins: result.homeGameWins,
          awayGameWins: result.awayGameWins,
          homePD: result.homePD,
          awayPD: result.awayPD,
          games: result.games,
          submittedAt: new Date().toISOString(),
        };

        await matchStore.set(match.id, JSON.stringify(match));

        // Update standings
        const hs = standings[home.id];
        const as = standings[away.id];

        hs.pts += result.homeRoundPts;
        as.pts += result.awayRoundPts;
        hs.gw += result.homeGameWins;
        hs.gl += result.awayGameWins;
        as.gw += result.awayGameWins;
        as.gl += result.homeGameWins;
        hs.pd += result.homePD;
        as.pd += result.awayPD;

        if (result.homeRoundPts > result.awayRoundPts) { hs.w++; as.l++; }
        else if (result.awayRoundPts > result.homeRoundPts) { as.w++; hs.l++; }
        else { hs.t++; as.t++; }
      }
    }

    // Sort and save standings
    const sorted = Object.values(standings).sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.pd !== a.pd) return b.pd - a.pd;
      return b.gw - a.gw;
    });

    await standingsStore.set(`circuit-i:${divId}`, JSON.stringify({
      seasonId: 'circuit-i',
      division: divId,
      divisionLabel: divLabel,
      standings: sorted,
      updatedAt: new Date().toISOString(),
    }));

    // ── Leaderboard entries (circuit points based on standing) ──
    const circuitPoints = [100, 75, 50, 30, 15, 15];
    for (let i = 0; i < sorted.length; i++) {
      const team = divTeams.find(t => t.id === sorted[i].teamId);
      if (!team) continue;
      for (const player of team.roster) {
        const entry = {
          id: `lb-${player.id}`,
          playerId: player.id,
          playerName: player.name,
          teamName: team.name,
          division: divId,
          divisionLabel: divLabel,
          seasonId: 'circuit-i',
          circuitPoints: circuitPoints[i] || 10,
          placement: i + 1,
          updatedAt: new Date().toISOString(),
        };
        await lbStore.set(entry.id, JSON.stringify(entry));
      }
    }
  }

  // ── Registrations (mix of team and agent) ──
  for (const team of allTeams) {
    const reg = {
      id: `reg-${rid()}`,
      seasonId: 'circuit-i',
      circuit: 'Circuit I',
      division: team.division,
      divisionLabel: team.division === '3-0-mixed' ? '3.0 Mixed' : '3.5 Mixed',
      path: 'team',
      status: 'confirmed',
      price: 450,
      team: { name: team.name, captain: team.captain, players: [team.roster[0]] },
      createdAt: new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
      confirmedAt: new Date(Date.now() - Math.random() * 25 * 86400000).toISOString(),
      amountPaid: 450,
    };
    await regStore.set(reg.id, JSON.stringify(reg));
  }

  // Add a few free agent registrations
  for (let i = 0; i < 4; i++) {
    const gender = i % 2 === 0 ? 'male' : 'female';
    const player = makePlayer(gender, usedNames);
    const div = i < 2 ? '3-0-mixed' : '3-5-mixed';
    const reg = {
      id: `reg-${rid()}`,
      seasonId: 'circuit-i',
      circuit: 'Circuit I',
      division: div,
      divisionLabel: div === '3-0-mixed' ? '3.0 Mixed' : '3.5 Mixed',
      path: 'agent',
      status: 'confirmed',
      price: 75,
      agent: { name: player.name, email: player.email, gender: player.gender, dupr: player.dupr },
      createdAt: new Date(Date.now() - Math.random() * 20 * 86400000).toISOString(),
      confirmedAt: new Date(Date.now() - Math.random() * 15 * 86400000).toISOString(),
      amountPaid: 75,
    };
    await regStore.set(reg.id, JSON.stringify(reg));
  }

  return new Response(JSON.stringify({
    ok: true,
    seeded: {
      season: season.name,
      divisions: 2,
      teams: allTeams.length,
      players: allTeams.reduce((n, t) => n + t.roster.length, 0),
      matches: 36,
      registrations: allTeams.length + 4,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
