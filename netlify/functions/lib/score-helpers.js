// netlify/functions/lib/score-helpers.js
// Pure scoring computation/validation/formatting. No storage, auth, or
// request handling here.
//
// ── Dual-entry verification model ───────────────────────────────────
// Each team enters its OWN copy of every game score (like keeping their
// own paper scoresheet). A game only counts once both versions match.
//
// Storage shape per slot:
//   game = {
//     home: N|null, away: N|null,          // canonical AGREED score — set only
//                                          // when both entries match & valid
//     homeEntry: { home, away, by, at } | null,   // home team's version
//     awayEntry: { home, away, by, at } | null,   // away team's version
//   }
//
// Computed status per game (server-derived, never persisted):
//   'empty'      neither team has entered anything
//   'partial'    only one team has a complete entry (or an entry in progress)
//   'confirmed'  both teams entered, versions MATCH, and it's a valid game
//   'mismatch'   both teams entered but the versions DISAGREE (or match on
//                an invalid score) — must be resolved before finalize
//
// Legacy records (single shared sheet: { home: N, away: N, by, at } — and the
// old admin shape { home: { entered, by, at } }) are migrated on read: the
// stored values are treated as agreed by both teams.

export const SLOT_RULES = {
  r1g1: { round: 1, game: 1 }, r1g2: { round: 1, game: 2 },
  r1g3: { round: 1, game: 3 }, r1g4: { round: 1, game: 4 },
  r1g5: { round: 1, game: 5 }, r1g6: { round: 1, game: 6 },
  r2g1: { round: 2, game: 1 }, r2g2: { round: 2, game: 2 },
  r2g3: { round: 2, game: 3 }, r2g4: { round: 2, game: 4 },
  r2g5: { round: 2, game: 5 }, r2g6: { round: 2, game: 6 },
};
export const SLOT_KEYS = Object.keys(SLOT_RULES);

export const PAIRS = [
  { id: 'r1p1', slots: ['r1g1','r1g2'], round: 1, pair: 1, label: 'Pair 1 · G1+G2' },
  { id: 'r1p2', slots: ['r1g3','r1g4'], round: 1, pair: 2, label: 'Pair 2 · G3+G4' },
  { id: 'r1p3', slots: ['r1g5','r1g6'], round: 1, pair: 3, label: 'Pair 3 · G5+G6' },
  { id: 'r2p1', slots: ['r2g1','r2g2'], round: 2, pair: 1, label: 'Pair 1 · G1+G2' },
  { id: 'r2p2', slots: ['r2g3','r2g4'], round: 2, pair: 2, label: 'Pair 2 · G3+G4' },
  { id: 'r2p3', slots: ['r2g5','r2g6'], round: 2, pair: 3, label: 'Pair 3 · G5+G6' },
];

export function emptyGame() {
  return { home: null, away: null, homeEntry: null, awayEntry: null };
}

export function newScoreRecord(match) {
  const games = {};
  for (const slot of SLOT_KEYS) games[slot] = emptyGame();
  return {
    matchId: match.id,
    circuit: match.circuit,
    division: match.division,
    week: match.week,
    championship: !!match.championship,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
    games,
    homeSubmittedAt: null, homeSubmittedBy: null, homeSignedName: null,
    awaySubmittedAt: null, awaySubmittedBy: null, awaySignedName: null,
    finalizedAt: null,
    createdAt: new Date().toISOString(),
  };
}

export function toScore(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 30) return 'INVALID';
  return n;
}

// An entry is "complete" when the team has typed both numbers.
export function entryComplete(e) {
  return !!e && Number.isInteger(e.home) && Number.isInteger(e.away);
}

export function entriesAgree(a, b) {
  return entryComplete(a) && entryComplete(b) && a.home === b.home && a.away === b.away;
}

// ── Legacy migration ────────────────────────────────────────────────
// Normalizes any historical game shape into the dual-entry shape, in place.
// Old single-sheet values are treated as agreed by both teams.
export function migrateGame(g) {
  if (!g) return emptyGame();
  if ('homeEntry' in g || 'awayEntry' in g) return g; // already new shape

  const isAdminSide = v => v && typeof v === 'object' && 'entered' in v;
  let home, away, by, at;
  if (isAdminSide(g.home) || isAdminSide(g.away)) {
    // Old admin-scores shape: { home: { entered, by, at }, away: {...} }
    home = isAdminSide(g.home) ? toInt(g.home.entered) : null;
    away = isAdminSide(g.away) ? toInt(g.away.entered) : null;
    by = (isAdminSide(g.home) ? g.home.by : null) || (isAdminSide(g.away) ? g.away.by : null) || null;
    at = (isAdminSide(g.home) ? g.home.at : null) || (isAdminSide(g.away) ? g.away.at : null) || null;
  } else {
    // Old captain shape: { home: N|null, away: N|null, by, at }
    home = toInt(g.home);
    away = toInt(g.away);
    by = g.by || null;
    at = g.at || null;
  }

  const hasAny = Number.isInteger(home) || Number.isInteger(away);
  const entry = hasAny ? { home, away, by, at } : null;
  return {
    home: null, away: null, // canonical re-derived by syncCanonical
    homeEntry: entry ? { ...entry } : null,
    awayEntry: entry ? { ...entry } : null,
  };
}

function toInt(v) { return Number.isInteger(v) ? v : null; }

// Recompute the canonical agreed score for a game from its two entries.
export function syncCanonical(game, winBy = 1) {
  if (entriesAgree(game.homeEntry, game.awayEntry)
      && isValidGame(game.homeEntry.home, game.homeEntry.away, winBy)) {
    game.home = game.homeEntry.home;
    game.away = game.homeEntry.away;
  } else {
    game.home = null;
    game.away = null;
  }
  return game;
}

// Migrate + re-derive canonical for the entire record, in place.
export function normalizeScore(score, championship = false) {
  const winBy = championship ? 2 : 1;
  score.games = score.games || {};
  for (const slot of SLOT_KEYS) {
    score.games[slot] = syncCanonical(migrateGame(score.games[slot]), winBy);
  }
  return score;
}

export function gameStatus(game, winBy = 1) {
  const g = migrateGame(game);
  const he = entryComplete(g.homeEntry);
  const ae = entryComplete(g.awayEntry);
  if (!he && !ae) {
    const anyValue = [g.homeEntry, g.awayEntry]
      .some(e => e && (Number.isInteger(e.home) || Number.isInteger(e.away)));
    return anyValue ? 'partial' : 'empty';
  }
  if (!he || !ae) return 'partial';
  if (!entriesAgree(g.homeEntry, g.awayEntry)) return 'mismatch';
  return isValidGame(g.homeEntry.home, g.homeEntry.away, winBy) ? 'confirmed' : 'mismatch';
}

// Dink Society game validity. All games are first-to-11.
//   Regular season: win by 1 → winner's score is exactly 11, loser 0–10.
//   Championship (week 8 finals): win by 2 → 11–9 (or better), or deuce past
//   11 ending on a 2-point lead (12–10, 13–11, …).
export function isValidGame(h, a, winBy = 1) {
  if (!Number.isInteger(h) || !Number.isInteger(a)) return false;
  if (h === a) return false;                 // must have a winner
  const hi = Math.max(h, a), lo = Math.min(h, a);
  if (winBy === 2) {
    if (hi < 11) return false;               // must reach 11
    if (hi - lo < 2) return false;           // win by 2
    return hi === 11 ? lo <= 9 : (hi - lo) === 2; // 11–9, or deuce ending +2
  }
  // Win by 1: winner reaches exactly 11.
  if (hi !== 11) return false;
  return lo >= 0 && lo <= 10;
}

export function decorate(score, championship = false) {
  const winBy = championship ? 2 : 1;
  normalizeScore(score, championship);

  // Status per game
  const gameStatuses = SLOT_KEYS.map(slot => ({
    slot,
    status: gameStatus(score.games[slot], winBy),
  }));

  const counts = gameStatuses.reduce((acc, g) => {
    acc[g.status] = (acc[g.status] || 0) + 1;
    return acc;
  }, { empty: 0, partial: 0, confirmed: 0, mismatch: 0 });

  // Round + match points (only count CONFIRMED games for round wins)
  const r1 = computeRound(score.games, 1, gameStatuses);
  const r2 = computeRound(score.games, 2, gameStatuses);
  const matchHome = r1.homePoints + r2.homePoints;
  const matchAway = r1.awayPoints + r2.awayPoints;
  const matchWinner = matchHome > matchAway ? 'home'
    : matchAway > matchHome ? 'away' : 'tie';

  const allConfirmed = counts.confirmed === 12;

  // Pair-level status
  const statusBySlot = Object.fromEntries(gameStatuses.map(g => [g.slot, g.status]));
  const pairStatuses = [];
  for (let idx = 0; idx < PAIRS.length; idx++) {
    const pair = PAIRS[idx];
    const slotSts = pair.slots.map(s => statusBySlot[s] || 'empty');
    const allConf = slotSts.every(s => s === 'confirmed');
    const hasMismatch = slotSts.some(s => s === 'mismatch');
    const hasPartial = slotSts.some(s => s === 'partial');
    pairStatuses.push({
      ...pair,
      slotStatuses: slotSts,
      confirmed: allConf,
      hasMismatch,
      locked: false, // no pair-sequential locking
      state: allConf ? 'confirmed'
           : hasMismatch ? 'mismatch'
           : hasPartial ? 'active'
           : 'pending',
    });
  }

  const canSubmit = allConfirmed;

  return {
    ...score,
    computed: {
      gameStatuses,
      counts,
      round1: r1,
      round2: r2,
      matchPoints: { home: matchHome, away: matchAway },
      matchWinner,
      allConfirmed,
      canSubmit,
      mismatches: gameStatuses.filter(g => g.status === 'mismatch').map(g => g.slot),
      unentered: gameStatuses.filter(g => g.status === 'empty' || g.status === 'partial').map(g => g.slot),
      pairStatuses,
    },
  };
}

export function computeRound(games, roundNum, gameStatuses) {
  const statusBySlot = Object.fromEntries(gameStatuses.map(g => [g.slot, g.status]));
  let homeGames = 0, awayGames = 0, scored = 0;
  for (let g = 1; g <= 6; g++) {
    const slot = `r${roundNum}g${g}`;
    if (statusBySlot[slot] !== 'confirmed') continue;
    const gs = games[slot];
    // Canonical agreed score (synced by normalizeScore for confirmed games).
    const h = Number.isInteger(gs.home) ? gs.home : gs.homeEntry?.home;
    const a = Number.isInteger(gs.away) ? gs.away : gs.homeEntry?.away;
    scored++;
    if (h > a) homeGames++;
    else if (a > h) awayGames++;
  }
  let homePoints = 0, awayPoints = 0;
  if (scored === 6) {
    if (homeGames > awayGames) homePoints = 2;
    else if (awayGames > homeGames) awayPoints = 2;
    else { homePoints = 1; awayPoints = 1; }
  }
  return { homeGames, awayGames, homePoints, awayPoints, scoredGames: scored };
}

export function prettySlot(slot) {
  const round = slot.startsWith('r1') ? 'R1' : 'R2';
  const game = slot.slice(-1);
  return `${round}G${game}`;
}
