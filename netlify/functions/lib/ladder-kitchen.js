// netlify/functions/lib/ladder-kitchen.js
//
// "Kitchen" — fun, lightweight season-wide stat categories for the public
// ladder pages and the admin scorer, modeled on the reference Pickleladder
// app's Kitchen tab. Pure functions over the same `sessions`/`players` shapes
// lib/ladder-scoring.js uses (session: {id, date, rounds}, player: {id, name,
// gender}), so results always match whatever has actually been scored — no
// separate source of truth, and it updates live as a night is being played
// (a session's `rounds` array just has fewer completed courts so far).
//
// A completed court needs t1/t2 both set AND a winner (a tie pending the
// admin's tie-break pick is excluded) — same rule calcStats() uses, so Kitchen
// numbers always agree with the rest of the site's stats.

import { calcStats, calcBonusPts, calcPartners, crownStr } from './ladder-scoring.js';

const shortDate = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}` : (d || ''); };
const byId = players => { const m = {}; (players || []).forEach(p => { m[p.id] = p; }); return m; };
const scored = c => !!(c.score && c.score.t1 != null && c.score.t2 != null && c.score.winner);

// Every category shows at most this many rows.
export const TOP_N = 10;

// Cut a fully-sorted array down to TOP_N rows. If the value at the cutoff spot
// ties with players who'd otherwise be silently excluded, don't pick some of
// the tied group to show and drop the rest arbitrarily — replace the whole
// tied block with a single `{tie:true, count}` sentinel row instead, so the
// UI can render an honest "N players tied" line. `valueKey` should read the
// same number the row displays, so a "tie" here always matches what's tied
// on screen.
export function limitWithTies(sorted, valueKey) {
  if (sorted.length <= TOP_N) return sorted;
  const boundaryVal = valueKey(sorted[TOP_N - 1]);
  if (valueKey(sorted[TOP_N]) !== boundaryVal) return sorted.slice(0, TOP_N); // no tie crossing the cutoff
  const firstTiedIdx = sorted.findIndex(r => valueKey(r) === boundaryVal);
  const above = sorted.slice(0, firstTiedIdx);
  const tieCount = sorted.filter(r => valueKey(r) === boundaryVal).length;
  return [...above, { tie: true, count: tieCount }];
}

// 🍳 One-Night Wonder — a player's best single-session point total.
function oneNightWonder(sessions, players, qualifiedIds) {
  const pById = byId(players);
  const best = {}; // id -> {pts, date}
  sessions.forEach(sess => {
    const pts = {};
    (sess.rounds || []).forEach(round => (round.courts || []).forEach(c => {
      if (!scored(c)) return;
      [[c.team1, c.score.t1], [c.team2, c.score.t2]].forEach(([team, pf]) => (team || []).filter(Boolean).forEach(p => { pts[p.id] = (pts[p.id] || 0) + pf; }));
    }));
    Object.entries(pts).forEach(([id, v]) => { if (!best[id] || v > best[id].pts) best[id] = { pts: v, date: sess.date }; });
  });
  const rows = Object.entries(best)
    .filter(([id]) => qualifiedIds.has(id))
    .map(([id, v]) => ({ id, name: pById[id]?.name, pts: v.pts, date: shortDate(v.date) }))
    .sort((a, b) => b.pts - a.pts);
  return limitWithTies(rows, r => r.pts);
}

// 👑 King of the Court — wins on the TOP court of each round (highest court number that round).
function kingOfTheCourt(sessions, players, qualifiedIds) {
  const pById = byId(players);
  const wins = {};
  sessions.forEach(sess => (sess.rounds || []).forEach(round => {
    const courts = round.courts || []; if (!courts.length) return;
    const tC = Math.max(...courts.map(c => c.court || 0));
    const top = courts.find(c => c.court === tC);
    if (!top || !scored(top)) return;
    const w = top.score.winner === 'A' ? top.team1 : top.team2;
    (w || []).filter(Boolean).forEach(p => { wins[p.id] = (wins[p.id] || 0) + 1; });
  }));
  const rows = Object.entries(wins)
    .filter(([id]) => qualifiedIds.has(id))
    .map(([id, v]) => ({ id, name: pById[id]?.name, wins: v }))
    .sort((a, b) => b.wins - a.wins);
  return limitWithTies(rows, r => r.wins);
}

// 📈 Per-Round Top — highest average points per round played (min 6 games).
function perRoundTop(stats, minGames = 6) {
  const rows = stats.filter(s => s.roundPts.length >= minGames)
    .map(s => ({ id: s.id, name: s.name, games: s.roundPts.length, avg: Math.round(s.pf / s.roundPts.length * 10) / 10 }))
    .sort((a, b) => b.avg - a.avg);
  return limitWithTies(rows, r => r.avg);
}

// 🏆 Most Points — season total including podium bonus, with ladder-win crowns.
function mostPoints(stats, bonus) {
  const rows = stats.map(s => { const b = bonus[s.id] || { bonus: 0, wins: 0 }; return { id: s.id, name: s.name, total: s.pf + (b.bonus || 0), crowns: b.wins || 0 }; })
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total);
  return limitWithTies(rows, r => r.total).map(r => r.tie ? r : ({ ...r, crownStr: crownStr(r.crowns) }));
}

// 🔥 Hot Streak — longest run of wins.
function hotStreak(stats) {
  const rows = stats.filter(s => s.maxStreak > 0).map(s => ({ id: s.id, name: s.name, streak: s.maxStreak }))
    .sort((a, b) => b.streak - a.streak);
  return limitWithTies(rows, r => r.streak);
}

// 🤝 Best Duo — partnership win% (min 3 games together). Both partners must
// individually clear the season qualification bar (same as every other card).
function bestDuo(sessions, players, minGames = 3, qualifiedIds) {
  const rows = calcPartners(sessions, players)
    .filter(p => (p.w + p.l) >= minGames && qualifiedIds.has(p.p1.id) && qualifiedIds.has(p.p2.id))
    .map(p => ({ a: p.p1.name, b: p.p2.name, w: p.w, l: p.l, pct: Math.round(100 * p.w / (p.w + p.l)) }))
    .sort((a, b) => b.pct - a.pct || (b.w - a.w));
  return limitWithTies(rows, r => r.pct);
}

// 🛡️ The Wall — lowest average points allowed (min 6 games).
function theWall(stats, minGames = 6) {
  const rows = stats.filter(s => s.roundPts.length >= minGames)
    .map(s => ({ id: s.id, name: s.name, avg: Math.round(s.pa / s.roundPts.length * 10) / 10 }))
    .sort((a, b) => a.avg - b.avg);
  return limitWithTies(rows, r => r.avg);
}

// ⚓ Iron Player — most ladders (nights) attended.
function ironPlayer(stats) {
  const rows = stats.filter(s => s.attended > 0).map(s => ({ id: s.id, name: s.name, nights: s.attended }))
    .sort((a, b) => b.nights - a.nights);
  return limitWithTies(rows, r => r.nights);
}

// 📊 Big Mover — biggest net court climb within a single ladder (first round
// they appeared in → last). Court ASSIGNMENT doesn't require a completed
// score (an unscored court still means they were standing on it).
function bigMover(sessions, players, qualifiedIds) {
  const pById = byId(players);
  const best = {}; // id -> {climb, date}
  sessions.forEach(sess => {
    const seen = {}; // id -> {first,last}
    (sess.rounds || []).forEach(round => (round.courts || []).forEach(c => {
      [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean).forEach(p => {
        const rec = seen[p.id] = seen[p.id] || { first: c.court, last: c.court };
        rec.last = c.court;
      });
    }));
    Object.entries(seen).forEach(([id, rec]) => {
      const climb = rec.last - rec.first;
      if (climb > 0 && (!best[id] || climb > best[id].climb)) best[id] = { climb, date: sess.date };
    });
  });
  const rows = Object.entries(best)
    .filter(([id]) => qualifiedIds.has(id))
    .map(([id, v]) => ({ id, name: pById[id]?.name, climb: v.climb, date: shortDate(v.date) }))
    .sort((a, b) => b.climb - a.climb);
  return limitWithTies(rows, r => r.climb);
}

// 💥 Beat Down — biggest single-game margin (both winning teammates credited separately).
function beatDown(sessions, players, qualifiedIds) {
  const pById = byId(players);
  const games = [];
  sessions.forEach(sess => (sess.rounds || []).forEach((round, ri) => (round.courts || []).forEach(c => {
    if (!scored(c)) return;
    const margin = Math.abs(c.score.t1 - c.score.t2); if (!margin) return;
    const winners = (c.score.winner === 'A' ? c.team1 : c.team2) || [];
    winners.filter(Boolean).forEach(p => games.push({ id: p.id, name: pById[p.id]?.name || p.name, round: ri + 1, margin }));
  })));
  const rows = games.filter(r => qualifiedIds.has(r.id)).sort((a, b) => b.margin - a.margin);
  return limitWithTies(rows, r => r.margin);
}

// 🎢 Comeback Kid — wins in the round right after a loss (within the same session).
function comebackKid(sessions, players, qualifiedIds) {
  const pById = byId(players);
  const counts = {};
  sessions.forEach(sess => {
    const seq = {}; // id -> [won,...] in round order
    (sess.rounds || []).forEach(round => (round.courts || []).forEach(c => {
      if (!scored(c)) return;
      [[c.team1, c.score.winner === 'A'], [c.team2, c.score.winner === 'B']].forEach(([team, won]) => (team || []).filter(Boolean).forEach(p => { (seq[p.id] = seq[p.id] || []).push(won); }));
    }));
    Object.entries(seq).forEach(([id, arr]) => { for (let i = 1; i < arr.length; i++) if (arr[i] && !arr[i - 1]) counts[id] = (counts[id] || 0) + 1; });
  });
  const rows = Object.entries(counts)
    .filter(([id]) => qualifiedIds.has(id))
    .map(([id, v]) => ({ id, name: pById[id]?.name, count: v }))
    .sort((a, b) => b.count - a.count);
  return limitWithTies(rows, r => r.count);
}

// 🎯 Highest Single Game — most points scored in one round.
function highestSingleGame(sessions, players, qualifiedIds) {
  const pById = byId(players);
  const best = {}; // id -> {pts, round}
  sessions.forEach(sess => (sess.rounds || []).forEach((round, ri) => (round.courts || []).forEach(c => {
    if (!scored(c)) return;
    [[c.team1, c.score.t1], [c.team2, c.score.t2]].forEach(([team, pf]) => (team || []).filter(Boolean).forEach(p => {
      if (!best[p.id] || pf > best[p.id].pts) best[p.id] = { pts: pf, round: ri + 1 };
    }));
  })));
  const rows = Object.entries(best)
    .filter(([id]) => qualifiedIds.has(id))
    .map(([id, v]) => ({ id, name: pById[id]?.name, pts: v.pts, round: v.round }))
    .sort((a, b) => b.pts - a.pts);
  return limitWithTies(rows, r => r.pts);
}

// Same eligibility bar as the season Leaderboard's "Not Yet Ranked" cutoff —
// 10 games / ~2 ladder nights — so a player can't top a Kitchen category off
// one big night before they've built up a real season sample.
export const MIN_KITCHEN_GAMES = 10;
export const MIN_KITCHEN_NIGHTS = 2;

// Build every Kitchen category. Pass already-computed `stats`/`bonus` when the
// caller has them (public-ladder-stats.js does, season-wide) to skip a second
// pass over the same sessions; omit them to have this compute its own.
//
// The 10-game/2-night qualification bar only applies when `stats` is passed
// in — i.e. the season-wide call. The single-event ("this night, live")
// caller omits it and gets its stats computed fresh from just that night's
// sessions, where nobody could ever hit a season-wide minimum; gating that
// case would empty out every category during live scoring. So: no min there,
// same as before this change — everyone who's played that night counts.
export function buildKitchen(sessions, players, stats, bonus) {
  const seasonWide = !!stats;
  stats = stats || calcStats(sessions, players);
  bonus = bonus || calcBonusPts(sessions, players);
  const qualifiedIds = seasonWide
    ? new Set(stats.filter(s => (s.w + s.l) >= MIN_KITCHEN_GAMES && (s.attended || 0) >= MIN_KITCHEN_NIGHTS).map(s => s.id))
    : new Set(players.map(p => p.id));
  const qStats = seasonWide ? stats.filter(s => qualifiedIds.has(s.id)) : stats;
  return {
    oneNightWonder: oneNightWonder(sessions, players, qualifiedIds),
    kingOfTheCourt: kingOfTheCourt(sessions, players, qualifiedIds),
    perRoundTop: perRoundTop(qStats),
    mostPoints: mostPoints(qStats, bonus),
    hotStreak: hotStreak(qStats),
    bestDuo: bestDuo(sessions, players, 3, qualifiedIds),
    theWall: theWall(qStats),
    ironPlayer: ironPlayer(qStats),
    bigMover: bigMover(sessions, players, qualifiedIds),
    beatDown: beatDown(sessions, players, qualifiedIds),
    comebackKid: comebackKid(sessions, players, qualifiedIds),
    highestSingleGame: highestSingleGame(sessions, players, qualifiedIds),
  };
}
