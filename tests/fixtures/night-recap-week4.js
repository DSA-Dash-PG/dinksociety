// tests/fixtures/night-recap-week4.js
//
// Season 2, Week 4 (Thu Oct 8, 2026), as the inputs lib/night-recap-data.js takes.
//
// REAL: the Happy Hour Hitters vs Bonkerz match — every lineup pairing and every
// game score — plus Richard Hak's season record, his week-by-week rating
// history, the Week 4 leaders, every match-point result of Weeks 1–4, each
// team's season totals, and the Week 5 schedule.
// RECONSTRUCTED: how the other eleven matches split their games and rally
// points round by round. Only the totals were on hand, so those splits are one
// consistent set that adds up to the real totals — fine for exercising the
// table and its tiebreaks, not a record of those nights.

const T = {
  bde: { id: 'bde', name: 'Big Dink Energy' },
  bonk: { id: 'bonk', name: 'Bonkerz' },
  dos: { id: 'dos', name: 'Dink or Swim' },
  hhh: { id: 'hhh', name: 'Happy Hour Hitters' },
  fp: { id: 'fp', name: 'FOURPLAY' },
  smash: { id: 'smash', name: 'Smash Society' },
};

const NIGHTS = { 1: '2026-09-18T01:00:00.000Z', 2: '2026-09-25T01:00:00.000Z', 3: '2026-10-02T01:00:00.000Z', 4: '2026-10-09T01:00:00.000Z' };
const FINAL = { 1: '2026-09-18T04:08:00.000Z', 2: '2026-09-25T04:13:00.000Z', 3: '2026-10-02T04:03:00.000Z', 4: '2026-10-09T03:31:22.950Z' };

// [week, n, home, away, matchPts home–away, round1 games, round2 games, rally points]
const RESULTS = [
  [1, 1, 'bde', 'fp', [4, 0], [5, 1], [5, 1], [135, 65]],
  [1, 2, 'bonk', 'smash', [1, 3], [2, 4], [3, 3], [93, 107]],
  [1, 3, 'dos', 'hhh', [4, 0], [5, 1], [4, 2], [115, 85]],
  [2, 1, 'bde', 'smash', [1, 3], [3, 3], [2, 4], [99, 102]],
  [2, 3, 'bonk', 'dos', [2, 2], [4, 2], [2, 4], [103, 98]],
  [2, 2, 'fp', 'hhh', [0, 4], [0, 6], [1, 5], [64, 136]],
  [3, 1, 'bde', 'hhh', [1, 3], [3, 3], [2, 4], [81, 120]],
  [3, 2, 'smash', 'dos', [4, 0], [6, 0], [5, 1], [131, 69]],
  [3, 3, 'fp', 'bonk', [0, 4], [0, 6], [0, 6], [65, 132]],
  [4, 1, 'bde', 'dos', [1, 3], [3, 3], [2, 4], [98, 102]],
  [4, 2, 'hhh', 'bonk', [1, 3], [0, 6], [3, 3], [96, 121]],
  [4, 3, 'smash', 'fp', [4, 0], [6, 0], [5, 1], [137, 62]],
];

export const seasonMatches = [
  ...RESULTS.map(([week, n, a, b, mp, r1, r2, pts]) => ({
    id: `m_II_w${week}_${n}`, week, division: '3.5+Mix',
    teamA: T[a], teamB: T[b], scoreA: mp[0], scoreB: mp[1],
    round1: { homeGames: r1[0], awayGames: r1[1] }, round2: { homeGames: r2[0], awayGames: r2[1] },
    pointsA: pts[0], pointsB: pts[1],
    scheduledAt: NIGHTS[week], finalizedAt: FINAL[week],
    venue: 'South End Racquet Club', ...(week === 4 && n === 2 ? { courtA: 5, courtB: 6 } : {}),
  })),
  // Week 5 — Thursday Oct 15, 6:00 PM Pacific.
  { id: 'm_II_w5_1', week: 5, division: '3.5+Mix', teamA: T.bde, teamB: T.bonk, scheduledAt: '2026-10-16T01:00:00.000Z', court: 'Courts 9 & 10', venue: 'South End Racquet Club' },
  { id: 'm_II_w5_2', week: 5, division: '3.5+Mix', teamA: T.dos, teamB: T.fp, scheduledAt: '2026-10-16T01:00:00.000Z', court: 'Courts 5 & 6', venue: 'South End Racquet Club' },
  { id: 'm_II_w5_3', week: 5, division: '3.5+Mix', teamA: T.hhh, teamB: T.smash, scheduledAt: '2026-10-16T01:00:00.000Z', court: 'Courts 7 & 8', venue: 'South End Racquet Club' },
];

const NAMES = {
  rich: 'Richard Hak', kevin: 'Kevin Vu', kc: 'KC Terada', pam: 'Pam Morioka', dot: 'Dot M.', devin: 'Devin Carroll',
  shalynn: 'Shalynn Ho', jason: 'Jason Phan',
  kayo: 'Kayo Hayashi', jmorales: 'Jennifer Morales', pascal: 'Pascal Hideux', sidney: 'Sidney Chan',
  madisen: 'Madisen Olsen', emanuel: 'Emanuel Escamilla', roel: 'Roel Boiser',
};
const GENDER = {
  rich: 'M', kevin: 'M', devin: 'M', jason: 'M', pascal: 'M', sidney: 'M', emanuel: 'M', roel: 'M',
  kc: 'F', pam: 'F', dot: 'F', shalynn: 'F', kayo: 'F', jmorales: 'F', madisen: 'F',
};

// Hitters (home) vs Bonkerz (away), Week 4 — the real card.
const pair = (p1, p2) => ({ p1, p2, p1Name: NAMES[p1], p2Name: NAMES[p2] });
export const lineupHHH = { games: {
  r1g1: pair('kc', 'pam'), r1g2: pair('kevin', 'rich'), r1g3: pair('pam', 'kevin'),
  r1g4: pair('kc', 'rich'), r1g5: pair('dot', 'devin'), r1g6: pair('kc', 'kevin'),
  r2g1: pair('pam', 'kc'), r2g2: pair('rich', 'devin'), r2g3: pair('dot', 'kevin'),
  r2g4: pair('kc', 'devin'), r2g5: pair('pam', 'devin'), r2g6: pair('dot', 'rich'),
} };
export const lineupBonk = { games: {
  r1g1: pair('kayo', 'jmorales'), r1g2: pair('pascal', 'sidney'), r1g3: pair('madisen', 'emanuel'),
  r1g4: pair('kayo', 'pascal'), r1g5: pair('madisen', 'sidney'), r1g6: pair('kayo', 'roel'),
  r2g1: pair('madisen', 'kayo'), r2g2: pair('emanuel', 'roel'), r2g3: pair('kayo', 'pascal'),
  r2g4: pair('madisen', 'sidney'), r2g5: pair('kayo', 'roel'), r2g6: pair('madisen', 'emanuel'),
} };
const g = (home, away) => ({ home, away });
export const scoreHHHvBonk = { games: {
  r1g1: g(6, 11), r1g2: g(10, 11), r1g3: g(3, 11), r1g4: g(6, 11), r1g5: g(6, 11), r1g6: g(9, 11),
  r2g1: g(7, 11), r2g2: g(10, 11), r2g3: g(6, 11), r2g4: g(11, 9), r2g5: g(11, 6), r2g6: g(11, 7),
} };

export const week4Match = seasonMatches.find(m => m.id === 'm_II_w4_2');

// ── player-stats ───────────────────────────────────────────────────────────
const basic = (id, extra = {}) => ({
  playerId: id, name: NAMES[id], gender: GENDER[id],
  gamesWon: 0, gamesLost: 0, diff: 0, clutchW: 0, clutchG: 0,
  byType: {}, partners: {}, dsrHistory: [], weeklyGameRecords: [], ...extra,
});
const ranked = (id, rank, dsr, extra = {}) => basic(id, { dsrHistory: [{ week: 4, dsr, rank, xDsr: null, xRank: null, gDsr: null, gRank: null }], ...extra });

const players = {
  // Richard's record is the real one.
  rich: basic('rich', {
    gamesWon: 8, gamesLost: 6, ps: 126, pa: 103, diff: 23, clutchW: 0, clutchG: 2,
    byType: { mens: { played: 6, won: 2 }, mixed: { played: 8, won: 6 } },
    partners: {
      shalynn: { played: 3, won: 3 }, jason: { played: 2, won: 2 }, devin: { played: 2, won: 0 },
      kevin: { played: 2, won: 0 }, kc: { played: 2, won: 1 }, dot: { played: 2, won: 1 }, pam: { played: 1, won: 1 },
    },
    dsrHistory: [
      { week: 1, dsr: 24.6, rank: 32, gDsr: -2.3, gRank: 18, xDsr: 40.3, xRank: 23 },
      { week: 2, dsr: 60.3, rank: 9, gDsr: 38.6, gRank: 11, xDsr: 69.5, xRank: 10 },
      { week: 3, dsr: 60.1, rank: 8, gDsr: 43.1, gRank: 10, xDsr: 71.7, xRank: 4 },
      { week: 4, dsr: 44.5, rank: 19, gDsr: 29.2, gRank: 11, xDsr: 63.8, xRank: 4 },
    ],
    weeklyGameRecords: [
      { week: 1, w: 1, l: 2, ps: 17, pa: 27 }, { week: 2, w: 4, l: 0, ps: 44, pa: 14 },
      { week: 3, w: 2, l: 1, ps: 28, pa: 22 }, { week: 4, w: 1, l: 3, ps: 37, pa: 40 },
    ],
  }),
  devin: ranked('devin', 21, 41.0), kevin: ranked('kevin', 30, 22.0), kc: ranked('kc', 26, 30.0),
  pam: ranked('pam', 25, 31.0), dot: ranked('dot', 22, 40.0), shalynn: ranked('shalynn', 10, 56.5), jason: basic('jason'),
  kayo: ranked('kayo', 14, 54.0), pascal: ranked('pascal', 3, 70.0, {
    dsrHistory: [{ week: 3, dsr: 62.0, rank: 7, gRank: 4, xRank: 6 }, { week: 4, dsr: 70.0, rank: 3, gRank: 2, xRank: 5 }],
    weeklyGameRecords: [{ week: 3, w: 6, l: 3, ps: 90, pa: 70 }, { week: 4, w: 3, l: 0, ps: 33, pa: 22 }],
  }),
  sidney: ranked('sidney', 27, 29.0), madisen: ranked('madisen', 7, 61.0), emanuel: ranked('emanuel', 9, 56.6), roel: ranked('roel', 16, 50.0),
  // One game all season: rated, not ranked.
  jmorales: basic('jmorales', { gamesWon: 1, gamesLost: 0, diff: 5, dsrHistory: [{ week: 4, dsr: 83.5, rank: null }], weeklyGameRecords: [{ week: 4, w: 1, l: 0, ps: 11, pa: 6 }] }),
};
// Fill the board out to the real 36 ranked players.
const taken = new Set(Object.values(players).map(p => p.dsrHistory.find(h => h.week === 4)?.rank).filter(Boolean));
for (let rank = 1; rank <= 36; rank++) {
  if (taken.has(rank)) continue;
  players[`filler${rank}`] = { playerId: `filler${rank}`, name: `Player ${rank}`, gender: rank % 2 ? 'M' : 'F', dsrHistory: [{ week: 4, dsr: 80 - rank, rank }], weeklyGameRecords: [] };
}
export const playerStats = { circuit: 'II', weeksPlayed: 4, needGames: 8, players };

// ── Week 4 leaders (real) ──────────────────────────────────────────────────
const L = (playerId, name, teamName, dsr, w, l, diff) => ({ playerId, name, teamName, dsr, w, l, diff });
const men = [L('ryan', 'Ryan Hom', 'Smash Society', 90.5, 4, 0, 30), L('kai', 'Kai Pylkkanen', 'Smash Society', 88.8, 4, 0, 23), L('matt', 'Matthew Pasqualetto', 'Smash Society', 86.0, 4, 0, 17)];
const women = [L('sally', 'Sally Whitty', 'Smash Society', 90.3, 4, 0, 30), L('annie', 'Annie Kang', 'Smash Society', 88.7, 4, 0, 27), L('jwit', 'Jennifer Witkowski', 'Smash Society', 88.6, 4, 0, 25)];
export const performers = {
  week: 4, label: 'Week 4', men, women,
  leaders: {
    men: { dsr: [...men, L('pascal', 'Pascal Hideux', 'Bonkerz', 83.8, 3, 0, 11), L('long', 'Long Thai', 'Dink or Swim', 65.3, 3, 1, 2), L('guilbert', 'Guilbert Balmaceda', 'Dink or Swim', 65.0, 3, 1, 3)] },
    women: { dsr: [...women, L('yolie', 'Yolie Pina', 'Dink or Swim', 84.1, 4, 0, 11), L('jmorales', 'Jennifer Morales', 'Bonkerz', 83.5, 1, 0, 5), L('kayo', 'Kayo Hayashi', 'Bonkerz', 76.4, 5, 1, 16)] },
  },
};

const roster = (ids) => ids.map(id => ({ id, name: NAMES[id], gender: GENDER[id], email: `${id}@example.com` }));
export const teamsById = new Map([
  ['hhh', { ...T.hhh, circuit: 'II', roster: roster(['rich', 'kevin', 'kc', 'pam', 'dot', 'devin', 'shalynn', 'jason']) }],
  ['bonk', { ...T.bonk, circuit: 'II', roster: roster(['kayo', 'jmorales', 'pascal', 'sidney', 'madisen', 'emanuel', 'roel']) }],
  ...['bde', 'dos', 'fp', 'smash'].map(k => [k, { ...T[k], circuit: 'II', roster: [] }]),
]);
export const nameOf = (id) => NAMES[id] || null;
