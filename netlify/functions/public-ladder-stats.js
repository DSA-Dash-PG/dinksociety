// netlify/functions/public-ladder-stats.js
// GET /api/public-ladder-stats          → season leaderboard + MVPs + streaks +
//                                          partnerships + recent winners (+ "you")
// GET /api/public-ladder-stats?event=ID → that night's standings + podium
//
// LADDER RANKING RULE: wins → point differential → Dink Rating. Applies to the
// season leaderboard, each night's standings, and who counts as a winner.
// Points scored (pf) is shown but does NOT decide rank. Uses the ported engine
// (lib/ladder-scoring.js) over play data so the math matches Pickleladder.

import { verifyPlayerSession } from './lib/auth.js';
import { getEvent } from './lib/ladder.js';
import { getPlay, listPlay, toSession, playersFromPlay } from './lib/ladder-play.js';
import { calcStats, calcDinkRating, calcBonusPts, calcMvpCount, calcPartners, calcXP, xpTier, getRoundMVPs } from './lib/ladder-scoring.js';
import { getXpConfig, getXpGrants, grantTotals } from './lib/xp-config.js';
import { getMergeMap, applyMerges } from './lib/player-merge.js';
import { getDirectory, applyDirectory } from './lib/player-directory.js';

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' } });
}

const avgOf = s => s.roundPts && s.roundPts.length ? Math.round(s.pf / s.roundPts.length * 10) / 10 : 0;

function rowFor(s, dr, bonus, mvp) {
  const b = bonus[s.id] || {};
  return {
    id: s.id, name: s.name, gender: s.gender,
    w: s.w, l: s.l, pf: s.pf, pa: s.pa, diff: s.pf - s.pa,
    avg: avgOf(s), topCt: s.best || 0, streak: s.streak, maxStreak: s.maxStreak,
    seasonPts: s.pf + (b.bonus || 0),
    bonus: b.bonus || 0,
    wins: b.wins || 0,
    podiums: (b.ladderResults || []).filter(r => r.rank <= 3).length,
    mvp: (mvp && mvp[s.id]) || 0,
    nights: s.attended,
    dr: dr[s.id],
  };
}

// THE ladder ranking: most wins, then point diff, then DR.
const rankRows = rows => rows.sort((a, b) => (b.w - a.w) || (b.diff - a.diff) || ((b.dr ?? -1) - (a.dr ?? -1)));

// Winner cards (top 3) — carry pts scored + diff + DR for the Home display.
const winnersFrom = rows => rows.slice(0, 3).map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, w: r.w, pf: r.pf, diff: r.diff, dr: r.dr }));

function buildRows(sessions, players) {
  const stats = calcStats(sessions, players);
  const dr = calcDinkRating(stats, sessions, players);
  const bonus = calcBonusPts(sessions, players);
  const mvp = calcMvpCount(sessions, players);
  const rows = rankRows(stats.filter(s => s.w + s.l > 0).map(s => rowFor(s, dr, bonus, mvp)));
  return { rows, stats, dr, bonus, mvp };
}

export default async (req) => {
  const eventId = new URL(req.url).searchParams.get('event');

  // ── one night ──
  if (eventId) {
    const event = await getEvent(eventId);
    const raw = await getPlay(eventId);
    if (!raw) return json({ event: event ? { id: event.id, name: event.name } : null, standings: [], winners: [], history: [] });
    const play = applyDirectory(applyMerges([raw], await getMergeMap()), await getDirectory())[0];
    const players = playersFromPlay([play]);
    const { rows } = buildRows([toSession(play)], players);
    // Round-by-round history: pairings, scores, movement context + round MVPs.
    const history = (play.rounds || []).map((rd, ri) => {
      const tC = Math.max(1, ...(rd.courts || []).map(c => c.court));
      const courts = [...(rd.courts || [])].sort((a, b) => b.court - a.court).map(c => {
        const sc = c.score || {};
        return {
          court: c.court, top: c.court === tC, bottom: c.court === 1,
          teamA: (c.team1 || []).filter(Boolean).map(p => p.name),
          teamB: (c.team2 || []).filter(Boolean).map(p => p.name),
          t1: sc.t1 ?? null, t2: sc.t2 ?? null, winner: sc.winner || null,
        };
      });
      const mv = getRoundMVPs(rd, players);
      const mp = x => x ? { name: x.p.name, diff: x.diff, court: x.court } : null;
      return { round: ri + 1, tC, courts, mvps: { male: mv.male.map(mp), female: mv.female.map(mp) } };
    });
    return json({ event: event ? { id: event.id, name: event.name, date: event.date, place: event.place, type: event.type } : null, standings: rows, winners: winnersFrom(rows), history });
  }

  // ── season-wide ──
  const plays = applyDirectory(applyMerges(await listPlay(), await getMergeMap()), await getDirectory());
  const sessions = plays.map(toSession);
  const players = playersFromPlay(plays);
  const { rows } = buildRows(sessions, players);

  // ── Divisions: group standings by each ladder's type. Men's/Women's are only
  // "active" once such a ladder has been played (i.e. it has standings rows). ──
  const typeByEvent = {};
  await Promise.all(plays.map(async p => { const ev = await getEvent(p.eventId).catch(() => null); typeByEvent[p.eventId] = ev?.type || 'mixed'; }));
  const divisions = { all: rows };
  const activeDivisions = ['all'];
  for (const d of ['mixed', 'mens', 'womens']) {
    const dPlays = plays.filter(p => (typeByEvent[p.eventId] || 'mixed') === d);
    const dRows = dPlays.length ? buildRows(dPlays.map(toSession), playersFromPlay(dPlays)).rows : [];
    divisions[d] = dRows;
    if (dRows.length) activeDivisions.push(d);
  }

  // ── XP: one cumulative engagement score across ALL ladders (place tiebreak = DR). ──
  const allStats = calcStats(sessions, players);
  const allDr = calcDinkRating(allStats, sessions, players);
  const xpCfg = await getXpConfig();
  const gTot = grantTotals(await getXpGrants());
  const { xp, detail } = calcXP(sessions, players, allDr, xpCfg.amounts);
  Object.keys(gTot).forEach(id => { if (id in xp) xp[id] += gTot[id]; });
  const pById = {}; players.forEach(p => { pById[p.id] = p; });
  const xpLeaderboard = Object.keys(xp)
    .filter(id => detail[id] && detail[id].nights > 0)
    .map(id => ({ id, name: pById[id]?.name, gender: pById[id]?.gender, xp: xp[id], nights: detail[id].nights, firsts: detail[id].firsts, tier: xpTier(xp[id]) }))
    .sort((a, b) => (b.xp - a.xp) || (b.nights - a.nights));
  const attachXP = arr => arr.forEach(r => { r.xp = xp[r.id] || 0; });
  attachXP(rows); Object.values(divisions).forEach(attachXP);

  const mvpLeaders = rows.filter(r => r.mvp > 0).sort((a, b) => b.mvp - a.mvp).slice(0, 6).map(r => ({ id: r.id, name: r.name, count: r.mvp }));
  const hotStreaks = rows.filter(r => r.maxStreak > 0).sort((a, b) => b.maxStreak - a.maxStreak).slice(0, 6).map(r => ({ id: r.id, name: r.name, streak: r.maxStreak }));
  const partnerships = calcPartners(sessions, players).slice(0, 8).map(p => ({ a: p.p1.name, b: p.p2.name, w: p.w, l: p.l, pct: (p.w + p.l) ? Math.round(100 * p.w / (p.w + p.l)) : 0 }));

  // recent nights' winners (newest first, up to 3 nights)
  const recent = plays.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 3);
  const recentWinners = await Promise.all(recent.map(async p => {
    const { rows: nr } = buildRows([toSession(p)], playersFromPlay([p]));
    const ev = await getEvent(p.eventId).catch(() => null);
    return { eventId: p.eventId, eventName: ev?.name || null, date: p.date, type: ev?.type || 'mixed', winners: winnersFrom(nr) };
  }));

  let you = null;
  const v = await verifyPlayerSession(req);
  if (v.valid) { const me = rows.find(r => r.id === v.payload.playerId); if (me) you = me; }

  return json({ leaderboard: rows, divisions, activeDivisions, xp: xpLeaderboard, mvpLeaders, hotStreaks, partnerships, recentWinners, you, hasData: rows.length > 0 });
};

export const config = { path: '/.netlify/functions/public-ladder-stats' };
