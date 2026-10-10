// tests/night-recap.test.js
// The league "morning-after" email goes to every player with nobody reading it
// first, so the numbers and the sentences are pinned here against a real night:
// Season 2 Week 4, Happy Hour Hitters vs Bonkerz (see the fixture's header for
// what is real and what is reconstructed).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchGames, nightByPlayer, tableThrough, tableWithMovement, buildNightModels,
  dueWeek, receiptRead, greeting, rankLine, teamRead, tableRead, bestMixed,
} from '../netlify/functions/lib/night-recap-data.js';
import { renderNightRecapEmail } from '../netlify/functions/lib/night-recap-email.js';
import {
  seasonMatches, week4Match, lineupHHH, lineupBonk, scoreHHHvBonk,
  playerStats, performers, teamsById, nameOf,
} from './fixtures/night-recap-week4.js';

const games = matchGames({ lineupA: lineupHHH, lineupB: lineupBonk, score: scoreHHHvBonk, nameOf });
const weekMatches = [{ match: week4Match, games }];
const build = (over = {}) => buildNightModels({
  circuit: 'II', week: 4, weekMatches, seasonMatches, playerStats, performers, teamsById, ...over,
});
const { models } = build();
const of = (id) => models.find(m => m.playerId === id);

test('matchGames keeps the twelve completed games and names both pairs', () => {
  assert.equal(games.length, 12);
  assert.deepEqual(games[1].home.names, ['Kevin Vu', 'Richard Hak']);
  assert.deepEqual(games[1].away.names, ['Pascal Hideux', 'Sidney Chan']);
  assert.equal(games[1].type, 'mens');
});

test('matchGames drops games with no winner, no score, or no lineup', () => {
  const score = { games: { r1g1: { home: 11, away: 11 }, r1g2: { home: 11, away: null }, r1g3: { home: 11, away: 4 } } };
  const lineupA = { games: { r1g1: { p1: 'a', p2: 'b' }, r1g2: { p1: 'a', p2: 'b' } } };  // no r1g3 pair
  const lineupB = { games: { r1g1: { p1: 'c', p2: 'd' }, r1g2: { p1: 'c', p2: 'd' }, r1g3: { p1: 'c', p2: 'd' } } };
  assert.equal(matchGames({ lineupA, lineupB, score }).length, 0);
});

test("each player's night adds up, and the team's diffs cancel against the score", () => {
  const night = nightByPlayer(weekMatches);
  const rec = (id) => { const n = night.get(id); return [n.w, n.l, n.diff]; };
  assert.deepEqual(rec('rich'), [1, 3, -3]);
  assert.deepEqual(rec('devin'), [2, 2, 1]);
  assert.deepEqual(rec('kevin'), [0, 4, -16]);
  assert.deepEqual(rec('kc'), [1, 4, -14]);
  assert.deepEqual(rec('kayo'), [5, 1, 16]);
  assert.deepEqual(rec('pascal'), [3, 0, 11]);
  // Two players a side, so the six Hitters' diffs sum to twice the 96–121 margin.
  const hitters = [...night.values()].filter(n => n.teamId === 'hhh').reduce((s, n) => s + n.diff, 0);
  assert.equal(hitters, 2 * (96 - 121));
});

test('the table after Week 4 is in tiebreak order with the real totals', () => {
  const t = tableThrough(seasonMatches, 4);
  assert.deepEqual(t.map(r => [r.teamName, r.pts, `${r.gw}-${r.gl}`, r.diff]), [
    ['Smash Society', 14, '36-12', 154],
    ['Bonkerz', 10, '32-16', 83],
    ['Dink or Swim', 9, '23-25', -33],
    ['Happy Hour Hitters', 8, '24-24', 56],
    ['Big Dink Energy', 7, '25-23', 24],
    ['FOURPLAY', 0, '4-44', -284],
  ]);
});

test('movement compares against the table a week earlier', () => {
  const move = Object.fromEntries(tableWithMovement(seasonMatches, 4).map(r => [r.teamId, r.delta]));
  assert.deepEqual(move, { smash: 0, bonk: 0, dos: 2, hhh: -1, bde: -1, fp: 0 });
  // Week 1 has no earlier table to move from.
  assert.ok(tableWithMovement(seasonMatches, 1).every(r => r.delta === null));
});

test('one model per player who played, and nobody who did not', () => {
  assert.equal(models.length, 13);
  assert.equal(of('shalynn'), undefined);
});

test("Richard's night: the numbers", () => {
  const m = of('rich');
  assert.deepEqual([m.night.w, m.night.l, m.night.ps, m.night.pa, m.night.diff], [1, 3, 37, 40, -3]);
  assert.deepEqual(m.night.games.map(g => [g.typeLabel, g.partnerName, `${g.my}-${g.opp}`]), [
    ["Men's", 'Kevin Vu', '10-11'], ['Mixed', 'KC Terada', '6-11'], ["Men's", 'Devin Carroll', '10-11'], ['Mixed', 'Dot M.', '11-7'],
  ]);
  assert.deepEqual(m.night.games[0].oppNames, ['Pascal Hideux', 'Sidney Chan']);
  const s = m.season;
  assert.deepEqual([s.w, s.l, s.diff, s.winPct], [8, 6, 23, 57]);
  assert.deepEqual([s.rank, s.prevRank, s.delta, s.rankedCount], [19, 8, -11, 36]);
  assert.deepEqual([s.dsr, s.dsrPrev, s.mixedRank, s.genderRank], [44.5, 60.1, 4, 11]);
  assert.deepEqual(m.partner, { name: 'Shalynn Ho', w: 3, l: 0 });
  assert.equal(m.night.courts, 'Courts 5 & 6');
});

test("Richard's night: the words", () => {
  const m = of('rich');
  assert.equal(m.hi, 'Closer than it reads, Richard.');
  assert.deepEqual(m.rankLine, { text: 'now 19th of 36', dir: -1, delta: 11 });
  assert.equal(m.read,
    "Two of your three losses finished 10–11. Flip those two and it's a 3–1 night. "
    + "Mixed went 1–1; men's went 0–2. "
    + 'At 6–2 in mixed this season you are #4 on the Mixed board.');
  assert.equal(m.subject, 'Richard, your Week 4 receipt: 1–3, now 19th overall');
  assert.equal(m.preheader, 'Down 11 to 19th overall. Happy Hour Hitters 1, Bonkerz 3. Next: Smash Society.');
});

test('the team block: rounds, closing run, and who played', () => {
  const t = of('rich').team;
  assert.deepEqual([t.mp, t.oppMp, t.gw, t.gl], [1, 3, 3, 9]);
  assert.deepEqual([t.r1, t.r2], [{ for: 0, against: 6 }, { for: 3, against: 3 }]);
  assert.deepEqual(t.points, { for: 96, against: 121 });
  assert.equal(t.closingRun, 3);
  assert.equal(t.read,
    'Bonkerz took Round 1 6–0. Round 2 was split 3–3. '
    + 'Happy Hour Hitters won the last three games on the card (11–9, 11–6, 11–7).');
  assert.deepEqual(t.roster.map(p => [p.name, p.w, p.l, p.diff, p.you]), [
    ['Devin Carroll', 2, 2, 1, false], ['Richard Hak', 1, 3, -3, true], ['Dot M.', 1, 2, -6, false],
    ['Pam Morioka', 1, 3, -12, false], ['KC Terada', 1, 4, -14, false], ['Kevin Vu', 0, 4, -16, false],
  ]);
  assert.deepEqual(t.season, { pts: 8, ptsAgainst: 8, gw: 24, gl: 24, diff: 56 });
});

test('the same match reads the other way round for Bonkerz', () => {
  const t = of('kayo').team;
  assert.deepEqual([t.name, t.mp, t.oppMp, t.r1, t.r2], ['Bonkerz', 3, 1, { for: 6, against: 0 }, { for: 3, against: 3 }]);
  assert.equal(t.read, 'Bonkerz took Round 1 6–0. Round 2 was split 3–3.');
  assert.equal(t.closingRun, 0);
});

test('the playoff line sentence says only what the table shows', () => {
  assert.equal(of('rich').tableRead, 'Happy Hour Hitters: 4th, holding the last playoff spot by 1 point over Big Dink Energy.');
  assert.equal(of('kayo').tableRead, 'Bonkerz: 2nd, 4 points behind Smash Society.');
  const t = tableThrough(seasonMatches, 4);
  assert.equal(tableRead(t, 'bde', 4), 'Big Dink Energy: 5th, 1 point behind Happy Hour Hitters for the last playoff spot.');
  assert.equal(tableRead(t, 'smash', 4), 'Smash Society: top of the table, 4 points clear of Bonkerz.');
  assert.equal(of('rich').playoffSpots, 4);
});

test('next up: the opponent, where they stand, and whether they have met', () => {
  const nx = of('rich').next;
  assert.deepEqual([nx.matchId, nx.week, nx.oppName, nx.oppRank, nx.oppPts, nx.oppPtsAgainst], ['m_II_w5_3', 5, 'Smash Society', 1, 14, 2]);
  assert.deepEqual([nx.courts, nx.venue, nx.meetings.length], ['Courts 7 & 8', 'South End Racquet Club', 0]);
  // Bonkerz have already met Big Dink Energy? No — but Dink or Swim v FOURPLAY have not either; a rematch shows its history.
  const withRematch = build({ seasonMatches: seasonMatches.map(m => (m.id === 'm_II_w5_3' ? { ...m, teamB: { id: 'dos', name: 'Dink or Swim' } } : m)) });
  assert.deepEqual(withRematch.models.find(m => m.playerId === 'rich').next.meetings, [{ week: 1, for: 0, against: 4 }]);
});

test('a bye shows as a bye, and a team with nothing ahead shows nothing', () => {
  const noW5 = seasonMatches.filter(m => m.week !== 5);
  assert.equal(build({ seasonMatches: noW5 }).models.find(m => m.playerId === 'rich').next, null);
  assert.deepEqual(build({ seasonMatches: noW5, byesByWeek: { 5: ['hhh'] } }).models.find(m => m.playerId === 'rich').next, { bye: true, week: 5 });
});

test('honors come from the site leaders: top 5 by gender, Player of the Week, best mixed', () => {
  assert.deepEqual([of('pascal').honors.weekRank, of('pascal').honors.weekDsr, of('pascal').honors.potw], [4, 83.8, false]);
  assert.equal(of('jmorales').honors.weekRank, 5);
  assert.equal(of('kayo').honors.weekRank, null);          // 6th on the women's list
  assert.equal(of('rich').honors.weekRank, null);
  assert.deepEqual(of('rich').potw.men.name, 'Ryan Hom');
  const mixed = bestMixed(nightByPlayer(weekMatches), id => playerStats.players[id]?.gender);
  assert.deepEqual([mixed.men.name, mixed.men.w, mixed.men.l, mixed.men.diff], ['Pascal Hideux', 2, 0, 10]);
  assert.deepEqual([mixed.women.name, mixed.women.w, mixed.women.l, mixed.women.diff], ['Kayo Hayashi', 3, 1, 7]);
  assert.equal(of('pascal').honors.bestMixed, true);
});

test('an unbeaten night and a climb read as one', () => {
  const m = of('pascal');
  assert.equal(m.hi, 'Unbeaten night, Pascal.');
  assert.deepEqual(m.rankLine, { text: 'now 3rd of 36', dir: 1, delta: 4 });
  assert.ok(m.read.startsWith('Nobody took a game off you. The biggest was 11–6 with Kayo.'));
  assert.equal(m.subject, 'Pascal, your Week 4 receipt: 3–0 and up 4 spots');
});

test('a player short of the games bar is told how far, never given a rank', () => {
  const m = of('jmorales');
  assert.equal(m.season.rank, null);
  assert.deepEqual(m.rankLine, { text: 'Not ranked yet · 1 of 8 games', dir: 0, delta: null });
  assert.ok(m.read.endsWith('Seven more games puts you on the rankings.'));
  assert.equal(m.subject, 'Jennifer, your Week 4 receipt: 1–0');
});

test('copy helpers hold their tongue when the numbers do not back a line', () => {
  const night = (gs) => {
    const games = gs.map(([my, opp, type = 'mixed']) => ({ my, opp, won: my > opp, type, partnerName: 'Sam Lee' }));
    const byType = {};
    for (const x of games) { const b = byType[x.type] || (byType[x.type] = { w: 0, l: 0, diff: 0 }); x.won ? b.w++ : b.l++; }
    return { games, w: games.filter(x => x.won).length, l: games.filter(x => !x.won).length, byType };
  };
  const unranked = { rank: null, gamesToRank: 0 };
  // Blown out four times: no "flip those" fantasy, no rank claim.
  const rough = night([[2, 11], [3, 11], [4, 11], [5, 11]]);
  assert.equal(receiptRead(rough, unranked), '');
  assert.equal(greeting(rough, 'Sam'), 'Tough one, Sam.');
  // One close loss out of three does not turn 1–3 into a winning night.
  assert.equal(receiptRead(night([[10, 11], [2, 11], [3, 11], [11, 4]]), unranked), 'One of your three losses finished 10–11.');
  assert.equal(rankLine({ rank: 5, delta: 0, rankedCount: 30 }).text, 'held 5th of 30');
  assert.equal(rankLine({ rank: 5, delta: null, newlyRanked: true, rankedCount: 30 }).text, 'on the board · 5th of 30');
  assert.equal(teamRead({ name: 'A', oppName: 'B', mp: 4, oppMp: 0, gw: 10, gl: 2, r1: { for: 5, against: 1 }, r2: { for: 5, against: 1 }, closingRun: 6 }),
    'A swept both rounds, 10–2 in games.');
});

test('the rendered email carries the numbers, the in/out links, and escapes names', () => {
  const m = of('rich');
  const { subject, html } = renderNightRecapEmail(m, { site: 'https://dinksociety.app', inUrl: 'https://x.test/in?t=a&b=1', outUrl: 'https://x.test/out', availability: null });
  assert.equal(subject, m.subject);
  for (const s of ['Closer than it reads, Richard.', '10&ndash;11', 'now 19th of 36', "I'm in for Week 5", "I'm out",
    'https://x.test/in?t=a&amp;b=1', 'Playoff line &middot; top 4', 'Ryan Hom', 'Sally Whitty', 'First meeting this season.',
    'Thursday, Oct 15', '6:00 PM', 'Courts 7 &amp; 8', 'utm_source=night-recap', 'season=circuit-ii', 'Season 2 &middot; Week 4 &middot; Thu, Oct 8']) {
    assert.ok(html.includes(s), `missing: ${s}`);
  }
  assert.ok(html.indexOf('Next Up') < html.indexOf('Your Team') && html.indexOf('Your Team') < html.indexOf('The Table'));
  // Already answered → the status and a way to change it, not two fresh buttons.
  const answered = renderNightRecapEmail(m, { inUrl: 'https://x.test/in', outUrl: 'https://x.test/out', availability: 'in' }).html;
  assert.ok(answered.includes('marked <b') && answered.includes('https://x.test/out') && !answered.includes("I'm in for Week 5"));
  // No next match → no Next Up section, and the numbering closes up.
  const none = renderNightRecapEmail({ ...m, next: null }).html;
  assert.ok(!none.includes('Next Up') && none.includes('&#9313; Your Team'));
  const evil = renderNightRecapEmail({ ...m, name: 'Rich <b>', teamName: 'A & B', team: { ...m.team, name: 'A & B' } }).html;
  assert.ok(evil.includes('A &amp; B') && !evil.includes('A & B on'));
});

// ── when is a week due? ────────────────────────────────────────────────────
const at = (iso) => new Date(iso);

test('a week is due the morning after, 7:30 AM Pacific, once every match is final', () => {
  const upTo4 = seasonMatches; // Week 4 played Thu Oct 8 (6 PM Pacific), finalized 8:31 PM
  assert.deepEqual([dueWeek(upTo4, at('2026-10-09T05:00:00Z')).due, dueWeek(upTo4, at('2026-10-09T05:00:00Z')).reason], [false, 'waiting for the morning after']); // Thu 10 PM
  assert.equal(dueWeek(upTo4, at('2026-10-09T14:00:00Z')).reason, 'before 7:30 AM Pacific');   // Fri 7:00 AM
  const fri = dueWeek(upTo4, at('2026-10-09T14:30:00Z'));                                      // Fri 7:30 AM
  assert.deepEqual([fri.week, fri.due], [4, true]);
  assert.equal(dueWeek(upTo4, at('2026-10-10T03:30:00Z')).reason, 'after 8 PM Pacific, holding until morning'); // Fri 8:30 PM
  assert.equal(dueWeek(upTo4, at('2026-10-13T16:00:00Z')).reason, 'night is more than three days old');
});

test('an unfinalized match from the night holds the whole week back', () => {
  const open = seasonMatches.map(m => (m.id === 'm_II_w4_3' ? { ...m, finalizedAt: null, scoreA: null, scoreB: null } : m));
  const d = dueWeek(open, at('2026-10-09T15:00:00Z'));
  assert.deepEqual([d.week, d.due, d.reason], [4, false, '1 match not finalized yet']);
});

test('a score finalized minutes ago gets half an hour to settle', () => {
  const late = seasonMatches.map(m => (m.id === 'm_II_w4_3' ? { ...m, finalizedAt: '2026-10-09T15:50:00.000Z' } : m));
  assert.equal(dueWeek(late, at('2026-10-09T16:00:00Z')).reason, 'scores finalized in the last 30 minutes');
  assert.equal(dueWeek(late, at('2026-10-09T16:20:00Z')).due, true);
});

test('next week on the calendar does not block this one, and no results means nothing is due', () => {
  assert.equal(dueWeek(seasonMatches, at('2026-10-09T15:00:00Z')).week, 4);
  assert.deepEqual(dueWeek(seasonMatches.filter(m => !m.finalizedAt), at('2026-10-09T15:00:00Z')), { week: null, due: false, reason: 'no finalized matches' });
});
