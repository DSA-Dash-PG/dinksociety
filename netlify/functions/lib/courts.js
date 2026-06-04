// netlify/functions/lib/courts.js
//
// Court model for The Dink Society.
//
// A match uses 2 courts (a "set"). Within a match, Court A hosts games
// 1, 3, 5 (Women's + Mixed + Mixed) and Court B hosts games 2, 4, 6
// (Men's + Mixed + Mixed) — the two games in each wave run simultaneously,
// one per court. Round 2 uses the same two courts.
//
// The venue has 6 courts in 3 sets (court 4 is not used):
//   Set A = 1 & 2,  Set B = 3 & 6,  Set C = 5 & 7
//
// Court sets ROTATE across the season so every team plays on each set as
// evenly as possible — no team gets stuck on the same courts all season.

export const COURT_SETS = [
  { id: 'A', courtA: '1', courtB: '2' },
  { id: 'B', courtA: '3', courtB: '6' },
  { id: 'C', courtA: '5', courtB: '7' },
];

// Which court a given game number is played on within a match.
export function courtForGame(gameNum, courtA, courtB) {
  return (gameNum % 2 === 1) ? courtA : courtB; // odd games (1,3,5) → A, even (2,4,6) → B
}

const PERMS_3 = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/**
 * Assign a rotating court set to every match.
 *
 * @param {Array<Array<{teamAId,teamBId}>>} weeks  weeks → matches (in slot order)
 * @returns {Array<Array<{teamAId,teamBId,courtSet,courtA,courtB}>>}
 *
 * Within each week the (up to 3) matches get DISTINCT sets — all 6 courts run
 * at once. Across weeks we greedily pick the set permutation that has the two
 * teams play on sets they've used least, balancing every team across A/B/C.
 */
export function assignCourtSets(weeks) {
  const count = {};                       // teamId → [usesA, usesB, usesC]
  const ensure = (id) => (count[id] || (count[id] = [0, 0, 0]));

  return weeks.map((week) => {
    const n = week.length;
    let best = PERMS_3[0], bestCost = Infinity;

    for (const perm of PERMS_3) {
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const s = perm[i];
        cost += ensure(week[i].teamAId)[s] + ensure(week[i].teamBId)[s];
      }
      if (cost < bestCost) { bestCost = cost; best = perm; }
    }

    return week.map((m, i) => {
      const s = best[i % best.length];
      ensure(m.teamAId)[s]++;
      ensure(m.teamBId)[s]++;
      const set = COURT_SETS[s];
      return { ...m, courtSet: set.id, courtA: set.courtA, courtB: set.courtB };
    });
  });
}
