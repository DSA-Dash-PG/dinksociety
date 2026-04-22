// netlify/functions/lib/standings.js
//
// Rebuilds the standings + player-stats aggregates for a given Circuit from
// scratch. Called by:
//   - captain-score.js on match finalize (event-driven refresh)
//   - admin-rebuild-standings.js for manual re-runs
//
// Output blobs:
//   standings/<circuit>.json       → per-division team standings + weekly top teams
//   player-stats/<circuit>.json    → per-player aggregate stats
//
// Strategy: full rebuild every time. Circuit has ~30 matches max, so the scan
// cost is cheap (~60 blob reads). Keeps the logic simple and idempotent.

import { getStore } from '@netlify/blobs';

const DIVISIONS = ['3.0M', '3.5M', '3.5W'];

// Slot type by slot key (matches captain-score.js / captain-lineup.js)
const SLOT_TYPE = {
  r1g1: 'womens', r1g2: 'mens', r1g3: 'mixed', r1g4: 'mixed', r1g5: 'mixed', r1g6: 'mixed',
  r2g1: 'womens', r2g2: 'mens', r2g3: 'mixed', r2g4: 'mixed', r2g5: 'mixed', r2g6: 'mixed',
};
const SLOT_KEYS = Object.keys(SLOT_TYPE);

// Society Circuit placement bonuses
const PLACEMENT_BONUS = [100, 75, 50, 30, 15, 0];

// Weekly bonuses
const BONUS_MATCH_WIN = 10;
const BONUS_MATCH_TIE = 5;
const BONUS_SWEEP_EXTRA = 5;      // on top of match win
const BONUS_WEEK_TOP = 5;
const BONUS_WEEK_TOP_TIED = 3;    // if multiple teams tied for week's highest

/**
 * Rebuild standings and player stats for a Circuit.
 * @param {string} circuit e.g. "I"
 * @returns {Promise<{standings: object, playerStats: object}>}
 */
export async function rebuildStandings(circuit) {
  const scheduleStore = getStore('schedule');
  const lineupStore = getStore('lineups');
  const teamsStore = getStore('teams');

  // Load all schedule files for this circuit
  const { blobs: scheduleBlobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` });
  const weekFiles = [];
  for (const b of scheduleBlobs) {
    const data = await scheduleStore.get(b.key, { type: 'json' });
    if (data?.matches) weekFiles.push(data);
  }

  // Load all team records (needed for player names)
  const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' });
  const teamsById = new Map();
  for (const b of teamBlobs) {
    const t = await teamsStore.get(b.key, { type: 'json' });
    if (t) teamsById.set(t.id, t);
  }

  // Initialize division buckets
  const divisionBuckets = {};
  for (const div of DIVISIONS) divisionBuckets[div] = { teams: new Map(), weekly: {} };

  // Initialize player stats
  const playerStats = new Map();

  // Process each finalized match
  for (const weekFile of weekFiles) {
    const div = weekFile.division;
    const week = weekFile.week;
    if (!divisionBuckets[div]) divisionBuckets[div] = { teams: new Map(), weekly: {} };
    if (!divisionBuckets[div].weekly[week]) divisionBuckets[div].weekly[week] = [];

    for (const match of weekFile.matches) {
      if (!match.finalizedAt) continue;

      const teamA = match.teamA;
      const teamB = match.teamB;
      const matchPointsA = match.scoreA ?? 0;
      const matchPointsB = match.scoreB ?? 0;

      // Ensure team buckets exist
      for (const t of [teamA, teamB]) {
        if (!divisionBuckets[div].teams.has(t.id)) {
          divisionBuckets[div].teams.set(t.id, {
            teamId: t.id,
            teamName: t.name,
            division: div,
            matchesPlayed: 0,
            wins: 0, losses: 0, ties: 0,
            matchPointsFor: 0, matchPointsAgainst: 0,
            sweeps: 0,
            totalGamesWon: 0, totalGamesLost: 0,
            weeklyBonusPoints: 0,
            headToHead: {}, // { opponentId: { for, against } }
          });
        }
      }

      const a = divisionBuckets[div].teams.get(teamA.id);
      const b = divisionBuckets[div].teams.get(teamB.id);

      a.matchesPlayed++;
      b.matchesPlayed++;
      a.matchPointsFor += matchPointsA;
      a.matchPointsAgainst += matchPointsB;
      b.matchPointsFor += matchPointsB;
      b.matchPointsAgainst += matchPointsA;

      // Head-to-head
      if (!a.headToHead[teamB.id]) a.headToHead[teamB.id] = { for: 0, against: 0 };
      if (!b.headToHead[teamA.id]) b.headToHead[teamA.id] = { for: 0, against: 0 };
      a.headToHead[teamB.id].for += matchPointsA;
      a.headToHead[teamB.id].against += matchPointsB;
      b.headToHead[teamA.id].for += matchPointsB;
      b.headToHead[teamA.id].against += matchPointsA;

      // Games won from round1/round2
      const r1 = match.round1 || { homeGames: 0, awayGames: 0 };
      const r2 = match.round2 || { homeGames: 0, awayGames: 0 };
      a.totalGamesWon += (r1.homeGames || 0) + (r2.homeGames || 0);
      a.totalGamesLost += (r1.awayGames || 0) + (r2.awayGames || 0);
      b.totalGamesWon += (r1.awayGames || 0) + (r2.awayGames || 0);
      b.totalGamesLost += (r1.homeGames || 0) + (r2.homeGames || 0);

      // W/L/T + match-win bonus
      if (matchPointsA > matchPointsB) {
        a.wins++; b.losses++;
        a.weeklyBonusPoints += BONUS_MATCH_WIN;
      } else if (matchPointsB > matchPointsA) {
        b.wins++; a.losses++;
        b.weeklyBonusPoints += BONUS_MATCH_WIN;
      } else {
        a.ties++; b.ties++;
        a.weeklyBonusPoints += BONUS_MATCH_TIE;
        b.weeklyBonusPoints += BONUS_MATCH_TIE;
      }

      // Sweep bonus (4-0)
      if (matchPointsA === 4 && matchPointsB === 0) {
        a.sweeps++;
        a.weeklyBonusPoints += BONUS_SWEEP_EXTRA;
      } else if (matchPointsB === 4 && matchPointsA === 0) {
        b.sweeps++;
        b.weeklyBonusPoints += BONUS_SWEEP_EXTRA;
      }

      // Track week's match-point totals for top-team-of-week computation
      divisionBuckets[div].weekly[week].push({ teamId: teamA.id, matchPoints: matchPointsA });
      divisionBuckets[div].weekly[week].push({ teamId: teamB.id, matchPoints: matchPointsB });

      // ========== Player stats ==========
      // Need the lineup to know who played, then cross-reference scores
      await accumulatePlayerStats({
        matchId: match.id,
        teamAId: teamA.id,
        teamBId: teamB.id,
        teamsById,
        lineupStore,
        playerStats,
      });
    }
  }

  // Compute weekly top teams
  for (const div of Object.keys(divisionBuckets)) {
    const weekly = divisionBuckets[div].weekly;
    const weeklyTopTeams = {};
    for (const [week, entries] of Object.entries(weekly)) {
      // Aggregate per-team match points for this week (team could play multiple matches in a week in theory)
      const perTeam = {};
      for (const e of entries) {
        perTeam[e.teamId] = (perTeam[e.teamId] || 0) + e.matchPoints;
      }
      const top = Math.max(...Object.values(perTeam));
      const winners = Object.entries(perTeam).filter(([, pts]) => pts === top).map(([id]) => id);
      weeklyTopTeams[week] = winners;

      // Award bonus
      const bonus = winners.length === 1 ? BONUS_WEEK_TOP : BONUS_WEEK_TOP_TIED;
      for (const teamId of winners) {
        const team = divisionBuckets[div].teams.get(teamId);
        if (team) team.weeklyBonusPoints += bonus;
      }
    }
    divisionBuckets[div].weeklyTopTeams = weeklyTopTeams;
  }

  // Build final standings — sort each division
  const divisions = {};
  for (const div of Object.keys(divisionBuckets)) {
    const teams = Array.from(divisionBuckets[div].teams.values());
    if (teams.length === 0) continue;

    teams.sort(standingsComparator);

    // Apply placement bonus based on sorted position (projected until Circuit done)
    teams.forEach((t, idx) => {
      t.rank = idx + 1;
      t.placementBonus = PLACEMENT_BONUS[idx] ?? 0;
      t.societyCircuitPoints = t.weeklyBonusPoints + t.placementBonus;
    });

    divisions[div] = {
      teams,
      weeklyTopTeams: divisionBuckets[div].weeklyTopTeams,
    };
  }

  const standings = {
    circuit,
    lastUpdated: new Date().toISOString(),
    divisions,
  };

  const playerStatsOut = {
    circuit,
    lastUpdated: new Date().toISOString(),
    players: Object.fromEntries(playerStats),
  };

  // Write both aggregates
  const standingsStore = getStore('standings');
  const playerStatsStore = getStore('player-stats');
  await Promise.all([
    standingsStore.setJSON(`standings/${circuit}.json`, standings),
    playerStatsStore.setJSON(`player-stats/${circuit}.json`, playerStatsOut),
  ]);

  return { standings, playerStats: playerStatsOut };
}

/**
 * Standings comparator following Aloha-style tiebreakers:
 *   1. Match points (more = better)
 *   2. Total games won (more = better)
 *   3. Head-to-head match points (between tied teams)
 *   4. Point differential (for − against)
 */
function standingsComparator(a, b) {
  if (b.matchPointsFor !== a.matchPointsFor) return b.matchPointsFor - a.matchPointsFor;
  if (b.totalGamesWon !== a.totalGamesWon) return b.totalGamesWon - a.totalGamesWon;

  // Head-to-head: compare a.headToHead[b.id] vs b.headToHead[a.id]
  const aVsB = a.headToHead[b.teamId];
  const bVsA = b.headToHead[a.teamId];
  if (aVsB && bVsA) {
    if (aVsB.for !== bVsA.for) return bVsA.for - aVsB.for;
  }

  const aDiff = a.matchPointsFor - a.matchPointsAgainst;
  const bDiff = b.matchPointsFor - b.matchPointsAgainst;
  return bDiff - aDiff;
}

/**
 * Pulls lineup + score for a match, updates the playerStats map in place.
 */
async function accumulatePlayerStats({ matchId, teamAId, teamBId, teamsById, lineupStore, playerStats }) {
  const scoresStore = getStore('scores');

  const [lineupA, lineupB, score] = await Promise.all([
    lineupStore.get(`lineup/${matchId}/${teamAId}.json`, { type: 'json' }).catch(() => null),
    lineupStore.get(`lineup/${matchId}/${teamBId}.json`, { type: 'json' }).catch(() => null),
    scoresStore.get(`score/${matchId}.json`, { type: 'json' }).catch(() => null),
  ]);
  if (!lineupA || !lineupB || !score?.games) return;

  const teamA = teamsById.get(teamAId);
  const teamB = teamsById.get(teamBId);

  // Roster lookup maps for name resolution
  const rosterA = new Map((teamA?.roster || []).map(p => [p.id, p]));
  const rosterB = new Map((teamB?.roster || []).map(p => [p.id, p]));

  for (const slot of SLOT_KEYS) {
    const slotType = SLOT_TYPE[slot];
    const gs = score.games[slot];
    if (!gs?.home || !gs?.away) continue;
    // Only count games where both sides entered AND they match (confirmed)
    if (gs.home.entered !== gs.away.entered && gs.home.entered && gs.away.entered) continue;
    // Skip unconfirmed games
    if (gs.home.entered !== gs.away.entered) continue;

    const homeScore = gs.home.entered;
    const awayScore = gs.away.entered;
    if (homeScore === awayScore) continue; // individual game ties impossible in pickleball but guard

    const homeWon = homeScore > awayScore;

    const homePicks = lineupA.games?.[slot];
    const awayPicks = lineupB.games?.[slot];
    if (!homePicks || !awayPicks) continue;

    const homePlayers = [homePicks.p1, homePicks.p2].filter(Boolean);
    const awayPlayers = [awayPicks.p1, awayPicks.p2].filter(Boolean);

    for (const pid of homePlayers) {
      const player = rosterA.get(pid);
      if (!player) continue;
      bumpPlayer(playerStats, pid, player, teamA, slotType, homeWon, homePlayers.filter(p => p !== pid));
    }
    for (const pid of awayPlayers) {
      const player = rosterB.get(pid);
      if (!player) continue;
      bumpPlayer(playerStats, pid, player, teamB, slotType, !homeWon, awayPlayers.filter(p => p !== pid));
    }

    // Track distinct matches each player appeared in (handled separately below)
  }

  // Track matches played: one match per player per team
  const seenHome = new Set();
  const seenAway = new Set();
  for (const slot of SLOT_KEYS) {
    const hp = lineupA.games?.[slot];
    const ap = lineupB.games?.[slot];
    if (hp?.p1) seenHome.add(hp.p1);
    if (hp?.p2) seenHome.add(hp.p2);
    if (ap?.p1) seenAway.add(ap.p1);
    if (ap?.p2) seenAway.add(ap.p2);
  }
  for (const pid of seenHome) {
    const player = rosterA.get(pid);
    if (!player) continue;
    ensurePlayer(playerStats, pid, player, teamA);
    playerStats.get(pid).matchesPlayed++;
  }
  for (const pid of seenAway) {
    const player = rosterB.get(pid);
    if (!player) continue;
    ensurePlayer(playerStats, pid, player, teamB);
    playerStats.get(pid).matchesPlayed++;
  }
}

function ensurePlayer(map, pid, player, team) {
  if (!map.has(pid)) {
    map.set(pid, {
      playerId: pid,
      name: player.name,
      gender: player.gender || null,
      teamId: team?.id || null,
      teamName: team?.name || null,
      gamesPlayed: 0,
      gamesWon: 0,
      gamesLost: 0,
      byType: {
        womens: { played: 0, won: 0 },
        mens: { played: 0, won: 0 },
        mixed: { played: 0, won: 0 },
      },
      matchesPlayed: 0,
      partners: {}, // { partnerId: gamesPlayedTogether }
    });
  }
}

function bumpPlayer(map, pid, player, team, slotType, won, partners) {
  ensurePlayer(map, pid, player, team);
  const p = map.get(pid);
  p.gamesPlayed++;
  if (won) p.gamesWon++; else p.gamesLost++;
  p.byType[slotType].played++;
  if (won) p.byType[slotType].won++;
  for (const partnerId of partners) {
    p.partners[partnerId] = (p.partners[partnerId] || 0) + 1;
  }
}
