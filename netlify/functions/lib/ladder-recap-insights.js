// netlify/functions/lib/ladder-recap-insights.js
//
// Builds the STATS BRIEF for one finished ladder night — the input the Claude
// recap generator turns into Part 1 (per-player) + Part 2 (the night recap).
//
// All numbers come from the same ported scoring engine the public ladder stats
// use (wins → point diff → Dink Rating), so the recap math matches the site.
// Season context (prior finishes, best finish, streaks, attendance trend) comes
// from every OTHER finished night, which is what lets the copy reference past
// ladders for a season-long narrative.

import { getEvent, listEvents, getSignups } from './ladder.js';
import { getPlay, listPlay, toSession, playersFromPlay } from './ladder-play.js';
import { calcStats, calcDinkRating } from './ladder-scoring.js';
import { getMergeMap, applyMerges } from './player-merge.js';
import { getDirectory, applyDirectory } from './player-directory.js';

// Rank one night's field: most wins, then point diff, then Dink Rating.
function rankNight(play) {
  const players = playersFromPlay([play]);
  const sessions = [toSession(play)];
  const stats = calcStats(sessions, players);
  const dr = calcDinkRating(stats, sessions, players);
  const rows = stats.filter(s => s.w + s.l > 0).map(s => ({
    id: s.id, name: s.name, gender: s.gender || 'M',
    w: s.w, l: s.l, pf: s.pf, pa: s.pa, diff: s.pf - s.pa,
    maxStreak: s.maxStreak || 0, dr: dr[s.id] ?? null,
  }));
  rows.sort((a, b) => (b.w - a.w) || (b.diff - a.diff) || ((b.dr ?? -1) - (a.dr ?? -1)));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

// Scan a night's courts for per-player partners + who they beat, plus the
// highest- and closest-scoring completed games.
function nightGameFacts(play) {
  const partners = {}, beat = {};
  let topGame = null, closeGame = null;
  (play.rounds || []).forEach((rd, ri) => {
    (rd.courts || []).forEach(c => {
      const sc = c.score || {};
      if (sc.t1 == null || sc.t2 == null || !sc.winner) return;
      const a = (c.team1 || []).filter(Boolean), b = (c.team2 || []).filter(Boolean);
      const total = sc.t1 + sc.t2, margin = Math.abs(sc.t1 - sc.t2);
      const aWon = sc.winner === 't1' || sc.winner === 1 || sc.winner === '1';
      const winners = aWon ? a : b, losers = aWon ? b : a;
      const game = {
        score: `${Math.max(sc.t1, sc.t2)}–${Math.min(sc.t1, sc.t2)}`,
        winners: winners.map(p => p.name), losers: losers.map(p => p.name),
        round: ri + 1, court: c.court, total, margin,
      };
      if (!topGame || total > topGame.total) topGame = game;
      if (!closeGame || margin < closeGame.margin) closeGame = game;
      // partners + beat
      a.forEach(p => { (partners[p.id] = partners[p.id] || []).push(...a.filter(x => x.id !== p.id).map(x => x.name)); });
      b.forEach(p => { (partners[p.id] = partners[p.id] || []).push(...b.filter(x => x.id !== p.id).map(x => x.name)); });
      winners.forEach(p => { (beat[p.id] = beat[p.id] || []).push(...losers.map(x => x.name)); });
    });
  });
  return { partners, beat, topGame, closeGame };
}

const freqTop = (arr, n) => {
  const m = {}; (arr || []).forEach(x => { if (x) m[x] = (m[x] || 0) + 1; });
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
};

function pickAngle(p) {
  if (p.rank === 1) return 'won';
  if (p.isFirstPodium) return 'first_podium';
  if (p.rank <= 3) return 'podium';
  if (p.delta != null && p.delta >= 4) return 'big_climb';
  if (p.isBestFinish) return 'best_finish';
  if (p.maxStreak >= 3) return 'streak';
  if (p.delta != null && p.delta > 0) return 'climb';
  if (p.l > p.w) return 'tough';
  return 'steady';
}

/**
 * Build the full recap brief for one finished event.
 * Returns null if the event has no scored play yet.
 */
export async function buildRecapBrief(eventId) {
  const event = await getEvent(eventId);
  const rawTarget = await getPlay(eventId);
  if (!event || !rawTarget || !(rawTarget.rounds || []).length) return null;

  const mergeMap = await getMergeMap();
  const dir = await getDirectory();
  const norm = arr => applyDirectory(applyMerges(arr, mergeMap), dir);

  const [play] = norm([rawTarget]);
  const nightRows = rankNight(play);
  if (!nightRows.length) return null;

  // Every OTHER finished night, oldest → newest, for season context.
  const allPlays = norm((await listPlay()).filter(p => p.finished));
  const targetDate = String(play.date || event.date || '');
  const priorPlays = allPlays
    .filter(p => p.eventId !== eventId)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  // Per-player history across prior nights: ranks, finishes, podium count.
  const hist = {}; // id -> { ranks:[], counts }
  const rankedPrior = priorPlays.map(p => ({ date: p.date, rows: rankNight(p) }));
  rankedPrior.forEach(({ rows }) => rows.forEach(r => {
    (hist[r.id] = hist[r.id] || { ranks: [], podiums: 0, nights: 0, wins: 0 });
    hist[r.id].ranks.push(r.rank); hist[r.id].nights++;
    hist[r.id].wins += r.w; if (r.rank <= 3) hist[r.id].podiums++;
  }));
  // Most recent prior rank (last prior night the player appeared in).
  const lastRank = {};
  for (const { rows } of rankedPrior) rows.forEach(r => { lastRank[r.id] = r.rank; });

  const facts = nightGameFacts(play);

  const players = nightRows.map(r => {
    const h = hist[r.id] || { ranks: [], podiums: 0, nights: 0, wins: 0 };
    const priorRank = lastRank[r.id] ?? null;
    const delta = priorRank != null ? priorRank - r.rank : null; // +ve = climbed
    const allRanks = h.ranks.concat([r.rank]);
    const bestFinish = Math.min(...allRanks);
    const isBestFinish = h.ranks.length > 0 && r.rank < Math.min(...h.ranks);
    const isFirstPodium = r.rank <= 3 && h.podiums === 0;
    const out = {
      id: r.id, name: r.name, gender: r.gender, rank: r.rank,
      w: r.w, l: r.l, pf: r.pf, pa: r.pa, diff: r.diff,
      dr: r.dr != null ? Math.round(r.dr * 10) / 10 : null,
      maxStreak: r.maxStreak,
      priorRank, delta, bestFinish, isBestFinish, isFirstPodium,
      nights: h.nights + 1, seasonWins: h.wins + r.w, seasonPodiums: h.podiums + (r.rank <= 3 ? 1 : 0),
      partners: freqTop(facts.partners[r.id], 2),
      beat: freqTop(facts.beat[r.id], 2),
    };
    out.angle = pickAngle(out);
    return out;
  });

  // ── Recap-level facts ──
  const podium = nightRows.slice(0, 3).map(r => ({ rank: r.rank, name: r.name, w: r.w, l: r.l, diff: r.diff }));
  const movers = players.filter(p => p.delta != null).sort((a, b) => b.delta - a.delta);
  const biggestMover = (movers[0] && movers[0].delta > 0)
    ? { name: movers[0].name, from: movers[0].priorRank, to: movers[0].rank, jump: movers[0].delta, bestEver: movers[0].isBestFinish }
    : null;
  const males = nightRows.filter(r => r.gender !== 'F');
  const females = nightRows.filter(r => r.gender === 'F');
  const mvp = arr => arr.length ? { name: arr[0].name, w: arr[0].w, l: arr[0].l, diff: arr[0].diff } : null;

  // Attendance vs the average of the last up-to-3 prior nights.
  const prevCounts = rankedPrior.slice(-3).map(x => x.rows.length);
  const prevAvg = prevCounts.length ? Math.round(prevCounts.reduce((a, b) => a + b, 0) / prevCounts.length) : null;

  // Recipients: everyone on the paid roster with an email (league + lite alike).
  const signups = await getSignups(eventId).catch(() => null);
  const recipients = ((signups && signups.roster) || [])
    .filter(p => p.email)
    .map(p => ({ playerId: p.playerId || null, name: p.name, email: (p.email || '').toLowerCase() }));

  return {
    event: { id: event.id, name: event.name, date: event.date || play.date || null, type: event.type || 'mixed', place: event.place || null },
    night: {
      count: nightRows.length,
      courts: play.config?.courts || Math.max(1, ...((play.rounds?.[0]?.courts || []).map(c => c.court || 1))),
      rounds: (play.rounds || []).length,
      players,
    },
    recap: {
      podium,
      biggestMover,
      topGame: facts.topGame,
      closestGame: facts.closeGame,
      mvpMale: mvp(males), mvpFemale: mvp(females),
      attendance: { tonight: nightRows.length, prevAvg },
      seasonNightsSoFar: priorPlays.length + 1,
    },
    recipients,
  };
}
