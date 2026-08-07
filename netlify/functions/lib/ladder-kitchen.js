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

// 🍳 One-Night Wonder — a player's best single-session point total.
function oneNightWonder(sessions, players) {
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
  return Object.entries(best)
    .map(([id, v]) => ({ id, name: pById[id]?.name, pts: v.pts, date: shortDate(v.date) }))
    .sort((a, b) => b.pts - a.pts).slice(0, 5);
}

// 👑 King of the Court — wins on the TOP court of each round (highest court number that round).
function kingOfTheCourt(sessions, players) {
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
  return Object.entries(wins).map(([id, v]) => ({ id, name: pById[id]?.name, wins: v }))
    .sort((a, b) => b.wins - a.wins).slice(0, 5);
}

// 📈 Per-Round Top — highest average points per round played (min 6 games).
function perRoundTop(stats, minGames = 6) {
  return stats.filter(s => s.roundPts.length >= minGames)
    .map(s => ({ id: s.id, name: s.name, games: s.roundPts.length, avg: Math.round(s.pf / s.roundPts.length * 10) / 10 }))
    .sort((a, b) => b.avg - a.avg).slice(0, 5);
}

// 🏆 Most Points — season total including podium bonus, with ladder-win crowns.
function mostPoints(stats, bonus) {
  return stats.map(s => { const b = bonus[s.id] || { bonus: 0, wins: 0 }; return { id: s.id, name: s.name, total: s.pf + (b.bonus || 0), crowns: b.wins || 0 }; })
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total).slice(0, 5)
    .map(r => ({ ...r, crownStr: crownStr(r.crowns) }));
}

// 🔥 Hot Streak — longest run of wins.
function hotStreak(stats) {
  return stats.filter(s => s.maxStreak > 0).map(s => ({ id: s.id, name: s.name, streak: s.maxStreak }))
    .sort((a, b) => b.streak - a.streak).slice(0, 5);
}

// 🤝 Best Duo — partnership win% (min 3 games together).
function bestDuo(sessions, players, minGames = 3) {
  return calcPartners(sessions, players)
    .filter(p => (p.w + p.l) >= minGames)
    .map(p => ({ a: p.p1.name, b: p.p2.name, w: p.w, l: p.l, pct: Math.round(100 * p.w / (p.w + p.l)) }))
    .sort((a, b) => b.pct - a.pct || (b.w - a.w)).slice(0, 5);
}

// 🛡️ The Wall — lowest average points allowed (min 6 games).
function theWall(stats, minGames = 6) {
  return stats.filter(s => s.roundPts.length >= minGames)
    .map(s => ({ id: s.id, name: s.name, avg: Math.round(s.pa / s.roundPts.length * 10) / 10 }))
    .sort((a, b) => a.avg - b.avg).slice(0, 5);
}

// ⚓ Iron Player — most ladders (nights) attended.
function ironPlayer(stats) {
  return stats.filter(s => s.attended > 0).map(s => ({ id: s.id, name: s.name, nights: s.attended }))
    .sort((a, b) => b.nights - a.nights).slice(0, 5);
}

// 📊 Big Mover — biggest net court climb within a single ladder (first round
// they appeared in → last). Court ASSIGNMENT doesn't require a completed
// score (an unscored court still means they were standing on it).
function bigMover(sessions, players) {
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
  return Object.entries(best).map(([id, v]) => ({ id, name: pById[id]?.name, climb: v.climb, date: shortDate(v.date) }))
    .sort((a, b) => b.climb - a.climb).slice(0, 5);
}

// 💥 Beat Down — biggest single-game margin (both winning teammates credited separately).
function beatDown(sessions, players) {
  const pById = byId(players);
  const games = [];
  sessions.forEach(sess => (sess.rounds || []).forEach((round, ri) => (round.courts || []).forEach(c => {
    if (!scored(c)) return;
    const margin = Math.abs(c.score.t1 - c.score.t2); if (!margin) return;
    const winners = (c.score.winner === 'A' ? c.team1 : c.team2) || [];
    winners.filter(Boolean).forEach(p => games.push({ id: p.id, name: pById[p.id]?.name || p.name, round: ri + 1, margin }));
  })));
  return games.sort((a, b) => b.margin - a.margin).slice(0, 5);
}

// 🎢 Comeback Kid — wins in the round right after a loss (within the same session).
function comebackKid(sessions, players) {
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
  return Object.entries(counts).map(([id, v]) => ({ id, name: pById[id]?.name, count: v }))
    .sort((a, b) => b.count - a.count).slice(0, 5);
}

// 🎯 Highest Single Game — most points scored in one round.
function highestSingleGame(sessions, players) {
  const pById = byId(players);
  const best = {}; // id -> {pts, round}
  sessions.forEach(sess => (sess.rounds || []).forEach((round, ri) => (round.courts || []).forEach(c => {
    if (!scored(c)) return;
    [[c.team1, c.score.t1], [c.team2, c.score.t2]].forEach(([team, pf]) => (team || []).filter(Boolean).forEach(p => {
      if (!best[p.id] || pf > best[p.id].pts) best[p.id] = { pts: pf, round: ri + 1 };
    }));
  })));
  return Object.entries(best).map(([id, v]) => ({ id, name: pById[id]?.name, pts: v.pts, round: v.round }))
    .sort((a, b) => b.pts - a.pts).slice(0, 5);
}

// Build every Kitchen category. Pass already-computed `stats`/`bonus` when the
// caller has them (public-ladder-stats.js does, season-wide) to skip a second
// pass over the same sessions; omit them to have this compute its own.
export function buildKitchen(sessions, players, stats, bonus) {
  stats = stats || calcStats(sessions, players);
  bonus = bonus || calcBonusPts(sessions, players);
  return {
    oneNightWonder: oneNightWonder(sessions, players),
    kingOfTheCourt: kingOfTheCourt(sessions, players),
    perRoundTop: perRoundTop(stats),
    mostPoints: mostPoints(stats, bonus),
    hotStreak: hotStreak(stats),
    bestDuo: bestDuo(sessions, players),
    theWall: theWall(stats),
    ironPlayer: ironPlayer(stats),
    bigMover: bigMover(sessions, players),
    beatDown: beatDown(sessions, players),
    comebackKid: comebackKid(sessions, players),
    highestSingleGame: highestSingleGame(sessions, players),
  };
}
