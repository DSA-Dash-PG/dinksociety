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
import { circuitCode } from './circuit.js';
import { normalizeScore } from './score-helpers.js';
import { resolveBracketDisplay } from './bracket.js';

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
  // STRONG consistency is required here. rebuildStandings runs milliseconds
  // after captain-score.js writes finalizedAt into the schedule blob and the
  // score record — with default (eventual) reads it can get the PRE-write
  // copies and silently rebuild standings/stats to zero. Confirmed in prod
  // June 7 2026: schedule finalized at .260s, rebuild read stale at .604s.
  const scheduleStore = getStore({ name: 'schedule', consistency: 'strong' });
  const lineupStore = getStore({ name: 'lineups', consistency: 'strong' });
  const teamsStore = getStore({ name: 'teams', consistency: 'strong' });

  // Load all schedule files for this circuit. Keep the blob key alongside the
  // data so we can backfill per-match rally totals (pointsA/pointsB) into any
  // match finalized before that field existed.
  const { blobs: scheduleBlobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` });
  const weekFiles = [];
  for (const b of scheduleBlobs) {
    const data = await scheduleStore.get(b.key, { type: 'json' });
    if (data?.matches) weekFiles.push({ key: b.key, data, dirty: false });
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
  const weeklyPlayers = {}; // week → Map(pid → weekly game stats) for POW + rank movement
  const weekMeta = {};      // week → { date } for display
  const finalizedWeeks = new Set(); // regular-season weeks with any finalized match (ranking qualification)

  // Seed every rostered player AND every team for this circuit so the
  // leaderboard and standings list everyone (zeroed) even before a single game
  // is played. Match processing below simply bumps these existing records once
  // results come in.
  //
  // NOTE: team.circuit may hold a display name ("Season 1") or season id
  // ("circuit-i") rather than the bare code, so normalize before comparing.
  for (const team of teamsById.values()) {
    if (circuitCode(team.circuit) !== circuit) continue;

    // Team standing row at 0-0
    if (team.division) {
      const div = team.division;
      if (!divisionBuckets[div]) divisionBuckets[div] = { teams: new Map(), weekly: {} };
      if (!divisionBuckets[div].teams.has(team.id)) {
        divisionBuckets[div].teams.set(team.id, newTeamRow(team.id, team.name, div));
      }
    }

    for (const player of (team.roster || [])) {
      if (!player?.id) continue;
      ensurePlayer(playerStats, player.id, player, team);
    }
  }

  // Process each finalized match
  for (const wf of weekFiles) {
    const weekFile = wf.data;
    const div = weekFile.division;
    const week = weekFile.week;
    if (!divisionBuckets[div]) divisionBuckets[div] = { teams: new Map(), weekly: {} };
    if (!divisionBuckets[div].weekly[week]) divisionBuckets[div].weekly[week] = [];

    for (const match of weekFile.matches) {
      if (!match.finalizedAt) continue;
      // Playoffs & Championship are post-season — they must not feed the regular
      // standings table or player season stats. Rivalry Week DOES count (it is
      // the last week of the regular season).
      if (match.phase === 'playoff' || match.phase === 'championship') continue;

      if (match.scheduledAt && (!weekMeta[week] || new Date(match.scheduledAt) < new Date(weekMeta[week].date))) {
        weekMeta[week] = { date: match.scheduledAt };
      }
      finalizedWeeks.add(week);

      const teamA = match.teamA;
      const teamB = match.teamB;
      const matchPointsA = match.scoreA ?? 0;
      const matchPointsB = match.scoreB ?? 0;

      // Ensure team buckets exist
      for (const t of [teamA, teamB]) {
        if (!divisionBuckets[div].teams.has(t.id)) {
          divisionBuckets[div].teams.set(t.id, newTeamRow(t.id, t.name, div));
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

      // W/L/T are tallied per ROUND (2 rounds per match), not per match — so a
      // single match can produce 2-0, 1-0-1, 0-1-1, etc. Each round is won
      // (2 league pts), tied (1 pt), or lost (0 pts) by games taken, exactly
      // mirroring how PTS (matchPoints = round1 pts + round2 pts) accrues.
      // Read each round's own home/away points; fall back to the games count
      // for any legacy record written before points were stored.
      for (const r of [r1, r2]) {
        let hp = r.homePoints, ap = r.awayPoints;
        if (hp == null || ap == null) {
          const hg = r.homeGames || 0, ag = r.awayGames || 0;
          if (hg === 0 && ag === 0) continue;            // round not played
          hp = hg > ag ? 2 : hg < ag ? 0 : 1;
          ap = ag > hg ? 2 : ag < hg ? 0 : 1;
        }
        if (hp === 0 && ap === 0) continue;              // round not completed
        if (hp > ap) { a.wins++; b.losses++; }
        else if (ap > hp) { b.wins++; a.losses++; }
        else { a.ties++; b.ties++; }
      }

      // Match-win bonus (Society Circuit points) is still awarded at the match
      // level, based on total match points.
      if (matchPointsA > matchPointsB) {
        a.weeklyBonusPoints += BONUS_MATCH_WIN;
      } else if (matchPointsB > matchPointsA) {
        b.weeklyBonusPoints += BONUS_MATCH_WIN;
      } else {
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
      const acc = await accumulatePlayerStats({
        matchId: match.id,
        teamAId: teamA.id,
        teamBId: teamB.id,
        teamRowA: a,
        teamRowB: b,
        teamsById,
        lineupStore,
        playerStats,
        week,
        weeklyPlayers,
        championship: !!match.championship,
      });

      // Backfill per-match rally totals (pointsA/pointsB) onto the schedule for
      // any match finalized before captain-score started writing them, so the
      // week-snapshot views (which read the schedule) get PS/PA too. Only marks
      // the file dirty when a value is actually missing or stale.
      if (acc) {
        if (match.pointsA !== acc.pointsA || match.pointsB !== acc.pointsB) {
          match.pointsA = acc.pointsA;
          match.pointsB = acc.pointsB;
          wf.dirty = true;
        }
      }
    }
  }

  // Persist any schedule files whose matches were backfilled above.
  await Promise.all(
    weekFiles
      .filter(wf => wf.dirty)
      .map(wf => scheduleStore.setJSON(wf.key, wf.data))
  );

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

    // Before any matches are played there is no meaningful ranking, so order
    // teams alphabetically. Every consumer (public standings page + player/
    // captain portal) reads this same sorted array, so the order stays in sync.
    const anyPlayed = teams.some(t => (t.matchesPlayed || 0) > 0);
    if (anyPlayed) {
      teams.sort(standingsComparator);
    } else {
      teams.sort((a, b) => String(a.teamName).localeCompare(String(b.teamName)));
    }

    // Apply placement bonus based on sorted position (projected until Circuit done)
    teams.forEach((t, idx) => {
      t.rank = idx + 1;
      t.placementBonus = PLACEMENT_BONUS[idx] ?? 0;
      t.societyCircuitPoints = t.weeklyBonusPoints + t.placementBonus;
      t.pointDiff = t.pointsScored - t.pointsAgainst;  // DIFF = PS − PA
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

  // ── Composite score (Aloha formula) ──────────────────────────
  // Win% (×60) + Avg Diff (×15) + Clutch (×10) + Volume (×10) + Consistency (×5) = max 100
  const activePlayers = Array.from(playerStats.values()).filter(p => p.gamesPlayed > 0);
  const maxGames = Math.max(1, ...activePlayers.map(p => p.gamesPlayed));

  for (const p of playerStats.values()) {
    if (p.gamesPlayed === 0) { p.composite = null; continue; }
    const winPct    = p.gamesWon / p.gamesPlayed;
    const avgDiff   = p.diff / p.gamesPlayed;          // ~-11 to +11
    const volume    = p.gamesPlayed / maxGames;         // 0–1
    const clutchPct = p.clutchG > 0 ? p.clutchW / p.clutchG : winPct;

    let consistency = 1;
    if (p.gameDiffs.length >= 2) {
      const mean = p.gameDiffs.reduce((s, d) => s + d, 0) / p.gameDiffs.length;
      const variance = p.gameDiffs.reduce((s, d) => s + (d - mean) ** 2, 0) / p.gameDiffs.length;
      consistency = Math.max(0, 1 - (Math.sqrt(variance) / 8));
    }

    p.composite   = (winPct * 60) + (clutchPct * 10) + ((avgDiff / 11) * 15) + (consistency * 5) + (volume * 10);
    p.clutchPct   = clutchPct;
    p.consistency = consistency;
    // True per-game Avg Points %: mean of each game's (points won / points played).
    p.avgPointsPct = p.gamesScored ? Math.round((p.sumGamePct / p.gamesScored) * 1000) / 10 : null;
  }

  // ── Split composites: gender-line DSR + Mixed DSR ─────────────
  // Same formula per discipline. Volume is measured against that discipline's
  // own max games so the gender line (2 of 12 slots/night) isn't punished.
  const maxByType = { womens: 1, mens: 1, mixed: 1 };
  for (const p of activePlayers) {
    for (const t of ['womens', 'mens', 'mixed']) {
      maxByType[t] = Math.max(maxByType[t], p.byType?.[t]?.played || 0);
    }
  }
  // Ranking qualification: a player holds a rank once they've played MORE
  // than 6 games total, OR at least 50% of the games possible so far (~3 per
  // night → ceil(1.5 × weeks)): Wk1 = 2, Wk2 = 3, Wk3 = 5, Wk4 = 6, Wk5+ = 7.
  // Unqualified players keep their rating (shown "unqualified") but are
  // excluded from every rank pool.
  const weeksPlayed = finalizedWeeks.size;
  const needGames = qualifyThreshold(weeksPlayed);

  for (const p of playerStats.values()) {
    const g = normGender(p.gender);
    const gType = g === 'F' ? 'womens' : g === 'M' ? 'mens' : null;
    p.dsrGender = gType ? splitComposite(p.byType?.[gType], maxByType[gType]) : null;
    p.dsrMixed  = splitComposite(p.byType?.mixed, maxByType.mixed);
    const qualified = p.gamesPlayed >= needGames;
    p.dsrQualified       = qualified;
    p.dsrGenderQualified = qualified;
    p.dsrMixedQualified  = qualified;
  }
  // Ranks: gender line within the same gender pool; Mixed across everyone.
  // Only qualified players are ranked.
  for (const p of playerStats.values()) { p.dsrGenderRank = null; p.dsrMixedRank = null; }
  for (const gflag of ['M', 'F']) {
    rankByField(Array.from(playerStats.values()).filter(p => normGender(p.gender) === gflag && p.dsrGenderQualified), 'dsrGender', 'dsrGenderRank');
  }
  rankByField(Array.from(playerStats.values()).filter(p => p.dsrMixedQualified), 'dsrMixed', 'dsrMixedRank');

  // ── Weekly Player of the Week (gender-split, by that week's DSR) + rank movement ──
  const weeklyTopPerformers = buildWeeklyTopPerformers(weeklyPlayers, weekMeta);
  // Stamp each performer/leader with the player's cache-busted photo URL (or
  // null when they have none) so home + leaderboard render avatars exactly like
  // team/player pages — server-decided, not blind client-side 404 probes.
  for (const wk of weeklyTopPerformers) {
    const enrich = arr => { for (const e of (arr || [])) { const ps = playerStats.get(e.playerId); if (ps) e.photoUrl = ps.photoUrl || null; } };
    enrich(wk.men); enrich(wk.women);
    if (wk.leaders) for (const g of ['men', 'women']) { const L = wk.leaders[g]; if (L) for (const k of Object.keys(L)) enrich(L[k]); }
  }
  const { deltas: rankDeltas, history: dsrHistory } = computeRankDeltas(weeklyPlayers);
  for (const p of playerStats.values()) {
    p.rankDelta = Object.prototype.hasOwnProperty.call(rankDeltas, p.playerId) ? rankDeltas[p.playerId] : null;
    // Season-to-date DSR snapshot at the end of each week: [{ week, dsr, rank }].
    // Powers the match-log "DSR at time of game" column + the DSR trend chart.
    p.dsrHistory = dsrHistory.get(p.playerId) || [];
  }
  attachAwards(playerStats, weeklyTopPerformers);
  standings.weeklyTopPerformers = weeklyTopPerformers;

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

  // Once a phase completes, freeze the next bracket week's matchups into the
  // schedule blobs so they become concrete, playable matches (scoring/lineups
  // need real team ids). Projections stay unpersisted until then.
  try {
    await lockBracketSeeds(scheduleStore, weekFiles);
  } catch (e) {
    console.error('bracket seed lock failed:', e);
  }

  return { standings, playerStats: playerStatsOut };
}

/**
 * Standings comparator following Aloha-style tiebreakers:
 *   1. Match points (more = better)
 *   2. Total games won (more = better)
 *   3. Head-to-head match points (between tied teams)
 *   4. Rally-point differential (PS − PA)
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

  const aDiff = a.pointsScored - a.pointsAgainst;
  const bDiff = b.pointsScored - b.pointsAgainst;
  return bDiff - aDiff;
}

/**
 * Pulls lineup + score for a match, updates the playerStats map in place.
 */
async function accumulatePlayerStats({ matchId, teamAId, teamBId, teamRowA, teamRowB, teamsById, lineupStore, playerStats, week, weeklyPlayers, championship = false }) {
  // Strong read — the score record was written moments before finalize (see rebuildStandings).
  const scoresStore = getStore({ name: 'scores', consistency: 'strong' });

  const [lineupA, lineupB, score] = await Promise.all([
    lineupStore.get(`lineup/${matchId}/${teamAId}.json`, { type: 'json' }).catch(() => null),
    lineupStore.get(`lineup/${matchId}/${teamBId}.json`, { type: 'json' }).catch(() => null),
    scoresStore.get(`score/${matchId}.json`, { type: 'json' }).catch(() => null),
  ]);
  if (!lineupA || !lineupB || !score?.games) return null;

  // Migrate any legacy score shape and re-derive the canonical agreed
  // home/away values that the per-slot reads below depend on.
  normalizeScore(score, championship);

  const teamA = teamsById.get(teamAId);
  const teamB = teamsById.get(teamBId);

  // Roster lookup maps for name resolution
  const rosterA = new Map((teamA?.roster || []).map(p => [p.id, p]));
  const rosterB = new Map((teamB?.roster || []).map(p => [p.id, p]));

  // Per-match rally totals (home = teamA), returned for schedule backfill.
  let matchPointsScoredA = 0, matchPointsScoredB = 0;

  for (const slot of SLOT_KEYS) {
    const slotType = SLOT_TYPE[slot];
    const gs = score.games[slot];
    // Score shape: { home: <homeScore>|null, away: <awayScore>|null }.
    // Only count complete games (both scores entered, with a winner).
    const homeScore = gs?.home;
    const awayScore = gs?.away;
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) continue;

    // Team rally-point totals (PS = scored, PA = allowed). Counts every
    // completed game's points for the night. teamA is always the home side.
    matchPointsScoredA += homeScore;
    matchPointsScoredB += awayScore;
    if (teamRowA) { teamRowA.pointsScored += homeScore; teamRowA.pointsAgainst += awayScore; }
    if (teamRowB) { teamRowB.pointsScored += awayScore; teamRowB.pointsAgainst += homeScore; }

    if (homeScore === awayScore) continue; // a game must have a winner

    const homeWon = homeScore > awayScore;

    const homePicks = lineupA.games?.[slot];
    const awayPicks = lineupB.games?.[slot];
    if (!homePicks || !awayPicks) continue;

    const homePlayers = [homePicks.p1, homePicks.p2].filter(Boolean);
    const awayPlayers = [awayPicks.p1, awayPicks.p2].filter(Boolean);

    for (const pid of homePlayers) {
      const player = rosterA.get(pid);
      if (!player) continue;
      bumpPlayer(playerStats, pid, player, teamA, slotType, homeWon, homePlayers.filter(p => p !== pid), homeScore, awayScore, awayPlayers);
      if (weeklyPlayers) bumpWeeklyPlayer(weeklyPlayers, week, pid, player, teamA, homeWon, homeScore, awayScore, slotType);
    }
    for (const pid of awayPlayers) {
      const player = rosterB.get(pid);
      if (!player) continue;
      bumpPlayer(playerStats, pid, player, teamB, slotType, !homeWon, awayPlayers.filter(p => p !== pid), awayScore, homeScore, homePlayers);
      if (weeklyPlayers) bumpWeeklyPlayer(weeklyPlayers, week, pid, player, teamB, !homeWon, awayScore, homeScore, slotType);
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

  return { pointsA: matchPointsScoredA, pointsB: matchPointsScoredB };
}

// A fresh standings row for a team (all counters zeroed).
function newTeamRow(teamId, teamName, division) {
  return {
    teamId,
    teamName,
    division,
    matchesPlayed: 0,
    wins: 0, losses: 0, ties: 0,
    matchPointsFor: 0, matchPointsAgainst: 0,
    pointsScored: 0, pointsAgainst: 0,   // rally points across all games (PS/PA)
    pointDiff: 0,                        // PS − PA
    sweeps: 0,
    totalGamesWon: 0, totalGamesLost: 0,
    weeklyBonusPoints: 0,
    headToHead: {}, // { opponentId: { for, against } }
  };
}

function ensurePlayer(map, pid, player, team) {
  if (!map.has(pid)) {
    map.set(pid, {
      playerId: pid,
      name: player.name,
      gender: player.gender || null,
      photoUrl: player.photo?.updatedAt
        ? `/.netlify/functions/player-photo-serve?id=${encodeURIComponent(pid)}&v=${encodeURIComponent(player.photo.updatedAt)}`
        : null,
      teamId: team?.id || null,
      teamName: team?.name || null,
      gamesPlayed: 0,
      gamesWon: 0,
      gamesLost: 0,
      // Per-discipline splits now carry full scoring data so each discipline
      // gets its own composite (gender-line DSR + Mixed DSR).
      byType: {
        womens: newTypeSplit(),
        mens: newTypeSplit(),
        mixed: newTypeSplit(),
      },
      matchesPlayed: 0,
      // Scoring data (needed for composite score)
      ps: 0,         // points scored
      pa: 0,         // points allowed
      diff: 0,       // cumulative point differential
      sumGamePct: 0, // Σ per-game (myScore / total) — for true Avg Points %
      gamesScored: 0,// games that had a final score (denominator for the above)
      gameDiffs: [], // per-game diffs (for consistency calc)
      clutchW: 0,    // wins in close games (margin ≤ 3)
      clutchG: 0,    // close games played
      composite: null,
      partners: {},  // { partnerId: { played, won } }
      opponents: {}, // { opponentId: { played, won } }
    });
  }
}

// Fresh per-discipline split (full scoring data for the split composite).
function newTypeSplit() {
  return { played: 0, won: 0, ps: 0, pa: 0, diff: 0, gameDiffs: [], clutchW: 0, clutchG: 0 };
}

function bumpPlayer(map, pid, player, team, slotType, won, partners, myScore = null, oppScore = null, opponents = []) {
  ensurePlayer(map, pid, player, team);
  const p = map.get(pid);
  p.gamesPlayed++;
  if (won) p.gamesWon++; else p.gamesLost++;
  // Legacy blobs may lack the richer split fields — top up in place.
  if (!p.byType[slotType].gameDiffs) p.byType[slotType] = { ...newTypeSplit(), ...p.byType[slotType] };
  const bt = p.byType[slotType];
  bt.played++;
  if (won) bt.won++;

  // Track per-game scoring for composite score
  if (myScore !== null && oppScore !== null) {
    const d = myScore - oppScore;
    p.ps   += myScore;
    p.pa   += oppScore;
    p.diff += d;
    const tot = myScore + oppScore;
    if (tot > 0) { p.sumGamePct += myScore / tot; p.gamesScored++; }
    p.gameDiffs.push(d);
    if (Math.abs(d) <= 3) {
      p.clutchG++;
      if (won) p.clutchW++;
    }
    // Same tracking inside the discipline split
    bt.ps += myScore; bt.pa += oppScore; bt.diff += d;
    bt.gameDiffs.push(d);
    if (Math.abs(d) <= 3) { bt.clutchG++; if (won) bt.clutchW++; }
  }

  for (const partnerId of partners) {
    if (!p.partners[partnerId]) p.partners[partnerId] = { played: 0, won: 0 };
    p.partners[partnerId].played++;
    if (won) p.partners[partnerId].won++;
  }

  for (const opponentId of opponents) {
    if (!p.opponents[opponentId]) p.opponents[opponentId] = { played: 0, won: 0 };
    p.opponents[opponentId].played++;
    if (won) p.opponents[opponentId].won++;
  }
}

// ════════════════════════════════════════════════════════════════════
// Weekly DSR · Player of the Week (gender-split) · rank movement (+/-)
// ════════════════════════════════════════════════════════════════════

// Same Aloha composite formula, reusable for weekly + cumulative snapshots.
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

// Ranking qualification threshold: more than 6 games total OR at least 50% of
// possible games so far (~3 per night). ceil(1.5 × weeks), capped at 7.
function qualifyThreshold(weeksPlayed) {
  return Math.min(7, Math.ceil(1.5 * Math.max(0, weeksPlayed)));
}

// Composite for one discipline split ({played, won, diff, gameDiffs, clutch*}).
// Returns a rounded DSR or null when the split has no games.
function splitComposite(bt, maxGames) {
  if (!bt || !bt.played) return null;
  const s = compositeScore({
    gamesPlayed: bt.played,
    gamesWon: bt.won || 0,
    diff: bt.diff || 0,
    gameDiffs: bt.gameDiffs || [],
    clutchW: bt.clutchW || 0,
    clutchG: bt.clutchG || 0,
  }, Math.max(1, maxGames));
  return s == null ? null : Math.round(s * 10) / 10;
}

// Dense-ish rank by a numeric field (higher = better). Writes rankField onto
// each object; players without a value get null.
function rankByField(players, field, rankField) {
  const ranked = players.filter(p => p[field] != null).sort((a, b) => b[field] - a[field]);
  for (const p of players) p[rankField] = null;
  ranked.forEach((p, i) => { p[rankField] = i + 1; });
}

function ensureWeeklyPlayer(weekly, week, pid, player, team) {
  if (!weekly[week]) weekly[week] = new Map();
  const m = weekly[week];
  if (!m.has(pid)) m.set(pid, {
    playerId: pid, name: player.name, gender: player.gender || null,
    teamId: team?.id || null, teamName: team?.name || null,
    gamesPlayed: 0, gamesWon: 0, gamesLost: 0, ps: 0, diff: 0, gameDiffs: [], clutchW: 0, clutchG: 0,
    // Discipline splits for the week (g = gender line, x = mixed)
    g: newWeeklySplit(), x: newWeeklySplit(),
  });
  return m.get(pid);
}

function newWeeklySplit() {
  return { gamesPlayed: 0, gamesWon: 0, diff: 0, gameDiffs: [], clutchW: 0, clutchG: 0 };
}

function bumpWeeklyPlayer(weekly, week, pid, player, team, won, myScore, oppScore, slotType = null) {
  if (week == null) return;
  const p = ensureWeeklyPlayer(weekly, week, pid, player, team);
  p.gamesPlayed++; if (won) p.gamesWon++; else p.gamesLost++;
  const sp = slotType === 'mixed' ? p.x : (slotType === 'mens' || slotType === 'womens') ? p.g : null;
  if (sp) { sp.gamesPlayed++; if (won) sp.gamesWon++; }
  if (Number.isInteger(myScore)) p.ps += myScore;
  if (Number.isInteger(myScore) && Number.isInteger(oppScore)) {
    const d = myScore - oppScore; p.diff += d; p.gameDiffs.push(d);
    if (Math.abs(d) <= 3) { p.clutchG++; if (won) p.clutchW++; }
    if (sp) {
      sp.diff += d; sp.gameDiffs.push(d);
      if (Math.abs(d) <= 3) { sp.clutchG++; if (won) sp.clutchW++; }
    }
  }
}

// [{ week, label, date, men:[top3], women:[top3] }], newest week first.
function buildWeeklyTopPerformers(weekly, weekMeta = {}) {
  const out = [];
  const weeks = Object.keys(weekly).map(Number).sort((a, b) => a - b);
  for (const wk of weeks) {
    const players = Array.from(weekly[wk].values()).filter(p => p.gamesPlayed > 0);
    if (!players.length) continue;
    const maxGames = Math.max(1, ...players.map(p => p.gamesPlayed));
    players.forEach(p => { p._wdsr = compositeScore(p, maxGames); });
    const mapP = p => ({ playerId: p.playerId, name: p.name, teamName: p.teamName, teamId: p.teamId,
      gender: p.gender, dsr: Math.round(p._wdsr * 10) / 10, w: p.gamesWon, l: p.gamesLost, ps: p.ps, diff: p.diff });
    const topN = g => players.filter(p => normGender(p.gender) === g)
      .sort((a, b) => (b._wdsr - a._wdsr) || (b.diff - a.diff))
      .slice(0, 3)
      .map(mapP);
    // Top-6 leaders by each metric (dsr / diff / ps) per gender — powers The
    // Drop's tabbed "Top Performers" card. Sorted independently so the Best-Diff
    // and Most-Points leaders aren't constrained to the DSR top 6.
    const lead = (g, key) => players.filter(p => normGender(p.gender) === g)
      .sort((a, b) => ((b[key] ?? -Infinity) - (a[key] ?? -Infinity)) || (b._wdsr - a._wdsr) || (b.diff - a.diff))
      .slice(0, 6)
      .map(mapP);
    const leaders = {
      men:   { dsr: lead('M', '_wdsr'), diff: lead('M', 'diff'), pts: lead('M', 'ps') },
      women: { dsr: lead('F', '_wdsr'), diff: lead('F', 'diff'), pts: lead('F', 'ps') },
    };
    out.push({ week: wk, label: `Week ${wk}`, date: weekMeta[wk]?.date || null, men: topN('M'), women: topN('F'), leaders });
  }
  return out.sort((a, b) => b.week - a.week);
}

// Weekly season-to-date DSR snapshots. Returns:
//   deltas  — rank movement vs the prior week, { pid: delta|null } (+ = moved up)
//   history — Map(pid → [{ week, dsr, rank, gDsr, gRank, xDsr, xRank }])
//             end-of-week cumulative DSR + rank, overall and per discipline
//             (g = gender line ranked within gender, x = mixed ranked overall)
function computeRankDeltas(weekly) {
  const weeks = Object.keys(weekly).map(Number).sort((a, b) => a - b);
  const cum = new Map();
  const snaps = [];
  const history = new Map();
  const pushHist = (pid, entry) => {
    if (!history.has(pid)) history.set(pid, []);
    history.get(pid).push(entry);
  };
  for (const wk of weeks) {
    for (const [pid, w] of weekly[wk]) {
      if (!cum.has(pid)) cum.set(pid, {
        gender: w.gender || null,
        gamesPlayed: 0, gamesWon: 0, diff: 0, gameDiffs: [], clutchW: 0, clutchG: 0,
        g: newWeeklySplit(), x: newWeeklySplit(),
      });
      const c = cum.get(pid);
      c.gamesPlayed += w.gamesPlayed; c.gamesWon += w.gamesWon; c.diff += w.diff;
      for (const d of w.gameDiffs) c.gameDiffs.push(d);
      c.clutchW += w.clutchW; c.clutchG += w.clutchG;
      for (const key of ['g', 'x']) {
        const ws = w[key]; if (!ws) continue;
        const cs = c[key];
        cs.gamesPlayed += ws.gamesPlayed; cs.gamesWon += ws.gamesWon; cs.diff += ws.diff;
        for (const d of ws.gameDiffs) cs.gameDiffs.push(d);
        cs.clutchW += ws.clutchW; cs.clutchG += ws.clutchG;
      }
    }
    const active = [...cum.entries()].filter(([, c]) => c.gamesPlayed > 0);
    const maxGames  = Math.max(1, ...active.map(([, c]) => c.gamesPlayed));
    const maxGGames = Math.max(1, ...active.map(([, c]) => c.g.gamesPlayed));
    const maxXGames = Math.max(1, ...active.map(([, c]) => c.x.gamesPlayed));

    // Ranking qualification so far: >6 games OR 50% of possible (~3/night).
    // One TOTAL-games threshold gates every rank pool (overall + splits).
    const weeksSoFar = weeks.indexOf(wk) + 1;
    const qAll = qualifyThreshold(weeksSoFar);

    const rows = active.map(([pid, c]) => ({
      pid,
      gender: normGender(c.gender),
      games: c.gamesPlayed, gGames: c.g.gamesPlayed, xGames: c.x.gamesPlayed,
      s: compositeScore(c, maxGames),
      gS: c.g.gamesPlayed > 0 ? compositeScore(c.g, maxGGames) : null,
      xS: c.x.gamesPlayed > 0 ? compositeScore(c.x, maxXGames) : null,
    }));

    // Overall rank — qualified players only
    const ranked = rows.filter(r => r.games >= qAll).sort((a, b) => b.s - a.s);
    const snap = new Map();
    ranked.forEach((r, i) => { snap.set(r.pid, i + 1); r._rank = i + 1; });
    // Gender-line rank within each gender pool (same total-games qualification)
    for (const gflag of ['M', 'F']) {
      const pool = rows.filter(r => r.gender === gflag && r.gS != null && r.games >= qAll).sort((a, b) => b.gS - a.gS);
      pool.forEach((r, i) => { r._gRank = i + 1; });
    }
    // Mixed rank across everyone (same total-games qualification)
    const xPool = rows.filter(r => r.xS != null && r.games >= qAll).sort((a, b) => b.xS - a.xS);
    xPool.forEach((r, i) => { r._xRank = i + 1; });

    const round1 = v => (v == null ? null : Math.round(v * 10) / 10);
    for (const r of rows) {
      pushHist(r.pid, {
        week: wk,
        dsr: round1(r.s), rank: r._rank ?? null,
        gDsr: round1(r.gS), gRank: r._gRank ?? null,
        xDsr: round1(r.xS), xRank: r._xRank ?? null,
      });
    }
    snaps.push(snap);
  }
  const cur = snaps[snaps.length - 1] || new Map();
  const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : new Map();
  const deltas = {};
  for (const [pid, rank] of cur) {
    const pr = prev.get(pid);
    deltas[pid] = (pr == null) ? null : (pr - rank);
  }
  return { deltas, history };
}

// ════════════════════════════════════════════════════════════════════
// Bracket seed locking
// ════════════════════════════════════════════════════════════════════
//
// When a phase finishes (round-robin → rivalry → semifinals), the next bracket
// week's matchups become final. We persist the resolved teams into the schedule
// blobs so those matches can be played (lineups + scoring need real team ids).
// Until a phase completes, bracket teams stay null in the blob and are resolved
// as live previews by public-schedule.js / admin-matches.js.
async function lockBracketSeeds(scheduleStore, weekFiles) {
  // Group the loaded schedule files by division.
  const byDiv = {};
  for (const wf of weekFiles) {
    const div = wf.data?.division;
    if (!div) continue;
    (byDiv[div] ||= []).push(wf);
  }

  const dirtyFiles = new Set();
  for (const files of Object.values(byDiv)) {
    const realMatches = [], bracketMatches = [], teamMap = new Map();
    // map each bracket match id → its owning {wf, m} so we can mutate the blob.
    const owner = new Map();
    for (const wf of files) {
      const week = wf.data.week, division = wf.data.division;
      for (const m of (wf.data.matches || [])) {
        if (m.phase) {
          bracketMatches.push({ ...m, week, division });
          owner.set(m.id, { wf, m });
        } else {
          realMatches.push({ ...m, week, division });
          if (m.teamA?.id) teamMap.set(m.teamA.id, { id: m.teamA.id, name: m.teamA.name });
          if (m.teamB?.id) teamMap.set(m.teamB.id, { id: m.teamB.id, name: m.teamB.name });
        }
      }
    }
    if (!bracketMatches.length) continue;
    const numTeams = teamMap.size;
    if (numTeams < 2 || numTeams % 2 !== 0) continue;

    const resolved = resolveBracketDisplay({
      realMatches, bracketMatches, teamList: [...teamMap.values()], numTeams,
    });
    for (const r of resolved) {
      if (!r.seedLocked || !r.teamA?.id || !r.teamB?.id) continue;
      const o = owner.get(r.id);
      if (!o) continue;
      const changed = (o.m.teamA?.id !== r.teamA.id) || (o.m.teamB?.id !== r.teamB.id);
      if (changed) {
        o.m.teamA = { id: r.teamA.id, name: r.teamA.name };
        o.m.teamB = { id: r.teamB.id, name: r.teamB.name };
        dirtyFiles.add(o.wf);
      }
    }
  }

  await Promise.all([...dirtyFiles].map(wf => scheduleStore.setJSON(wf.key, wf.data)));
}

// Tag each week's #1 male + #1 female onto their player record as a Chef of the Week award.
function attachAwards(playerMap, weeklyTopPerformers) {
  for (const wk of weeklyTopPerformers) {
    for (const [entry, type] of [[wk.men[0], 'mens'], [wk.women[0], 'womens']]) {
      if (!entry) continue;
      const p = playerMap.get(entry.playerId);
      if (!p) continue;
      (p.awards = p.awards || []).push({
        week: wk.week, label: wk.label, date: wk.date, type,
        dsr: entry.dsr, w: entry.w, l: entry.l, diff: entry.diff,
      });
    }
  }
}
