// netlify/functions/lib/score-helpers.js
// Pure scoring computation/validation/formatting, extracted verbatim from
// captain-score.js. No storage, auth, or request handling here.
//
// Storage shape:
//   game = { home: <homeScore>|null, away: <awayScore>|null, by, at }
//
// Computed status per game (server-derived, never persisted):
//   'empty'      both scores null
//   'partial'    one score entered
//   'confirmed'  both entered AND a valid finished game
//   'mismatch'   both entered but NOT valid (e.g. not won by 2) — needs fixing

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

export function newScoreRecord(match) {
  const games = {};
  for (const slot of SLOT_KEYS) games[slot] = { home: null, away: null };
  return {
    matchId: match.id,
    circuit: match.circuit,
    division: match.division,
    week: match.week,
    championship: !!match.championship,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
    games,
    homeSubmittedAt: null, homeSubmittedBy: null,
    awaySubmittedAt: null, awaySubmittedBy: null,
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

export function gameStatus(game, winBy = 1) {
  const hHas = Number.isInteger(game?.home);
  const aHas = Number.isInteger(game?.away);
  if (!hHas && !aHas) return 'empty';
  if (!hHas || !aHas) return 'partial';
  // Both scores entered → 'confirmed' if it's a legal finished game, else 'mismatch'.
  return isValidGame(game.home, game.away, winBy) ? 'confirmed' : 'mismatch';
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
      locked: false, // single-entry: no pair-sequential locking
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
    const h = gs.home;
    const a = gs.away;
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
