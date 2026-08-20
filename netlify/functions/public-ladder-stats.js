// netlify/functions/public-ladder-stats.js
// GET /api/public-ladder-stats          → season leaderboard + MVPs + streaks +
//                                          partnerships + recent winners (+ "you")
// GET /api/public-ladder-stats?event=ID → that night's standings + podium
// GET /api/public-ladder-stats?division=womens → the SAME season response, but
//                                          every field scoped to one division
//                                          (powers queen.html / king boards).
//
// LADDER RANKING RULE: wins → point differential → Dink Rating. Applies to the
// season leaderboard, each night's standings, and who counts as a winner.
// Points scored (pf) is shown but does NOT decide rank. Uses the ported engine
// (lib/ladder-scoring.js) over play data so the math matches Pickleladder.

import { verifyPlayerSession } from './lib/auth.js';
import { getEvent, listEvents } from './lib/ladder.js';
import { getPlay, listPlay, toSession, playersFromPlay } from './lib/ladder-play.js';
import { calcStats, calcDinkRating, calcBonusPts, calcMvpCount, calcPartners, calcXP, xpTier, getRoundMVPs } from './lib/ladder-scoring.js';
import { buildKitchen, limitWithTies, MIN_KITCHEN_GAMES, MIN_KITCHEN_NIGHTS } from './lib/ladder-kitchen.js';
import { getXpConfig, getXpGrants, grantTotals } from './lib/xp-config.js';
import { getMergeMap, applyMerges } from './lib/player-merge.js';
import { getDirectory, applyDirectory } from './lib/player-directory.js';
import { getBalanceCents } from './lib/credits.js';

function json(body, cache = 'public, max-age=20') {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': cache } });
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

// Build division rows by filtering already-computed season data rather than
// re-running all four calc functions from scratch for each division.
function buildDivisionRows(dPlays, allDr, allBonus, allMvp) {
  if (!dPlays.length) return [];
  const dPlayers = playersFromPlay(dPlays);
  const dSessions = dPlays.map(toSession);
  // Re-compute stats scoped to division plays only (needed for accurate W/L/pf within division).
  const dStats = calcStats(dSessions, dPlayers);
  // Reuse season-wide DR, bonus, and MVP — these are cumulative cross-division scores.
  const rows = rankRows(dStats.filter(s => s.w + s.l > 0).map(s => rowFor(s, allDr, allBonus, allMvp)));
  return rows;
}

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const eventId = params.get('event');
  // Optional division scope for the standalone Queen/King pages. Anything
  // other than a real division name is ignored, so a junk value degrades to
  // the normal season-wide response rather than an empty page.
  const division = ['mixed', 'mens', 'womens'].includes(params.get('division')) ? params.get('division') : null;

  // ── one night ──
  if (eventId) {
    const event = await getEvent(eventId);
    const raw = await getPlay(eventId);
    if (!raw) return json({ event: event ? { id: event.id, name: event.name } : null, standings: [], winners: [], history: [] });
    const play = applyDirectory(applyMerges([raw], await getMergeMap()), await getDirectory())[0];
    const players = playersFromPlay([play]);
    const nightSessions = [toSession(play)];
    const { rows } = buildRows(nightSessions, players);
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
    // Kitchen for just this one night — fun stats that build live as courts wrap,
    // same categories as the season-wide Kitchen but scoped to tonight only.
    const kitchen = buildKitchen(nightSessions, players);
    return json({ event: event ? { id: event.id, name: event.name, date: event.date, place: event.place, type: event.type } : null, standings: rows, winners: winnersFrom(rows), history, kitchen });
  }

  // ── season-wide ──
  // Only ladders that count toward the running leaderboard. Two exclusions:
  //   1. Deleted events — a removed ladder's scored night would otherwise linger
  //      as a nameless "Ladder" in winners and still count in standings.
  //   2. Held-out ladders — an organizer-run ladder whose `leaderboard` field is
  //      'pending' (awaiting the admin's approval) or 'excluded' (admin declined)
  //      stays on its own board but is kept OUT of the aggregate. A missing field
  //      counts as 'included', so every pre-existing/admin ladder is unaffected.
  const allEvents = await listEvents().catch(() => []);
  const eligibleIds = new Set(
    allEvents.filter(e => e.leaderboard !== 'pending' && e.leaderboard !== 'excluded').map(e => e.id)
  );
  const plays = applyDirectory(applyMerges(await listPlay(), await getMergeMap()), await getDirectory())
    .filter(p => eligibleIds.has(p.eventId));
  const sessions = plays.map(toSession);
  const players = playersFromPlay(plays);
  const { rows, stats: allStats, dr: allDr, bonus: allBonus, mvp: allMvp } = buildRows(sessions, players);

  // ── Event cache: fetch each unique event ONCE and reuse for both typeByEvent
  // and recentWinners — previously fired one getEvent() call per play record
  // in each of those two loops (O(2n) DB calls → O(unique events)). ──
  const uniqueEventIds = [...new Set(plays.map(p => p.eventId))];
  const eventCache = new Map();
  await Promise.all(uniqueEventIds.map(async id => {
    const ev = await getEvent(id).catch(() => null);
    eventCache.set(id, ev);
  }));

  // ── Divisions: group standings by each ladder's type. Men's/Women's are only
  // "active" once such a ladder has been played (i.e. it has standings rows). ──
  const typeByEvent = {};
  uniqueEventIds.forEach(id => { typeByEvent[id] = eventCache.get(id)?.type || 'mixed'; });

  const divisions = { all: rows };
  const activeDivisions = ['all'];
  for (const d of ['mixed', 'mens', 'womens']) {
    const dPlays = plays.filter(p => (typeByEvent[p.eventId] || 'mixed') === d);
    const dRows = buildDivisionRows(dPlays, allDr, allBonus, allMvp);
    divisions[d] = dRows;
    if (dRows.length) activeDivisions.push(d);
  }

  // ── XP: one cumulative engagement score across ALL ladders (place tiebreak = DR).
  // Reuse the season-wide stats + DR already computed above — no second pass needed. ──
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

  const kitchen = buildKitchen(sessions, players, allStats, allBonus);
  // These "season leader" cards now live in the Kitchen tab alongside the
  // categories above, so they share the same 10-game/2-night bar and the
  // same top-10-with-tie-line treatment (limitWithTies) as everything else
  // there. No separate hotStreaks here — Kitchen's own 🔥 Hot Streak category
  // (in `kitchen` above) is the exact same data (same source, same sort), so
  // there's only one of it now instead of two identical cards.
  const qualifiedIds = new Set(rows.filter(r => (r.w + r.l) >= MIN_KITCHEN_GAMES && (r.nights || 0) >= MIN_KITCHEN_NIGHTS).map(r => r.id));
  const mvpSorted = rows.filter(r => r.mvp > 0 && qualifiedIds.has(r.id)).sort((a, b) => b.mvp - a.mvp).map(r => ({ id: r.id, name: r.name, count: r.mvp }));
  const mvpLeaders = limitWithTies(mvpSorted, r => r.count);
  const partnerSorted = calcPartners(sessions, players)
    .filter(p => qualifiedIds.has(p.p1.id) && qualifiedIds.has(p.p2.id))
    .map(p => ({ a: p.p1.name, b: p.p2.name, w: p.w, l: p.l, pct: (p.w + p.l) ? Math.round(100 * p.w / (p.w + p.l)) : 0 }));
  const partnerships = limitWithTies(partnerSorted, r => r.pct);

  // recent events' results (newest first, up to 4). Includes the FULL field so the
  // Home tab can show the top-3 podium plus an expandable full standings.
  // Event metadata now comes from the cache — no extra DB calls here.
  const recent = plays.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 4);
  const recentWinners = recent.map(p => {
    const { rows: nr } = buildRows([toSession(p)], playersFromPlay([p]));
    const ev = eventCache.get(p.eventId) || null;
    return { eventId: p.eventId, eventName: ev?.name || null, date: p.date, type: ev?.type || 'mixed', winners: winnersFrom(nr), standings: nr };
  });

  // Top-3 finishers for EVERY event with a play, so the Completed tab can show the
  // same 1-2-3 chips as the Home "Latest winners" cards. Keyed by eventId.
  const winnersByEvent = {};
  for (const p of plays) {
    const { rows: nr } = buildRows([toSession(p)], playersFromPlay([p]));
    winnersByEvent[p.eventId] = nr.slice(0, 3).map(r => ({ id: r.id, name: r.name, w: r.w, l: r.l }));
  }

  // ── Division scope (?division=womens) ──────────────────────────────────
  // The Queen and King pages are the same season response viewed through one
  // division. Rather than a second endpoint, everything derived from `plays` is
  // recomputed over that division's plays only and swapped into the response.
  //
  // Deliberately NOT rescoped: dr, bonus and xp. Those are cumulative career
  // scores that follow a player across every format she plays — the same reason
  // buildDivisionRows reuses them. A player's DR shouldn't change depending on
  // which board you're looking at her from.
  let scoped = null;
  if (division) {
    const dPlays = plays.filter(p => (typeByEvent[p.eventId] || 'mixed') === division);
    const dPlayers = playersFromPlay(dPlays);
    const dSessions = dPlays.map(toSession);
    const dStats = calcStats(dSessions, dPlayers);
    const dBonus = calcBonusPts(dSessions, dPlayers);
    const dRows = divisions[division] || [];

    const dQualified = new Set(dRows
      .filter(r => (r.w + r.l) >= MIN_KITCHEN_GAMES && (r.nights || 0) >= MIN_KITCHEN_NIGHTS)
      .map(r => r.id));
    const dMvpSorted = dRows.filter(r => r.mvp > 0 && dQualified.has(r.id))
      .sort((a, b) => b.mvp - a.mvp).map(r => ({ id: r.id, name: r.name, count: r.mvp }));
    const dPartnerSorted = calcPartners(dSessions, dPlayers)
      .filter(p => dQualified.has(p.p1.id) && dQualified.has(p.p2.id))
      .map(p => ({ a: p.p1.name, b: p.p2.name, w: p.w, l: p.l, pct: (p.w + p.l) ? Math.round(100 * p.w / (p.w + p.l)) : 0 }));

    const dRecent = dPlays.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 4);
    const dWinnersByEvent = {};
    dPlays.forEach(p => { if (winnersByEvent[p.eventId]) dWinnersByEvent[p.eventId] = winnersByEvent[p.eventId]; });

    scoped = {
      leaderboard: dRows,
      kitchen: buildKitchen(dSessions, dPlayers, dStats, dBonus),
      mvpLeaders: limitWithTies(dMvpSorted, r => r.count),
      partnerships: limitWithTies(dPartnerSorted, r => r.pct),
      recentWinners: dRecent.map(p => {
        const { rows: nr } = buildRows([toSession(p)], playersFromPlay([p]));
        const ev = eventCache.get(p.eventId) || null;
        return { eventId: p.eventId, eventName: ev?.name || null, date: p.date, type: ev?.type || division, winners: winnersFrom(nr), standings: nr };
      }),
      winnersByEvent: dWinnersByEvent,
      hasData: dRows.length > 0,
      nights: new Set(dPlays.map(p => p.eventId)).size,
      players: dRows.length,
    };
  }

  let you = null, youCreditCents = 0;
  const v = await verifyPlayerSession(req);
  if (v.valid) {
    const me = rows.find(r => r.id === v.payload.playerId); if (me) you = me;
    const myEmail = v.payload.email || v.payload.session?.email || v.payload.player?.email || '';
    if (myEmail) youCreditCents = await getBalanceCents(myEmail).catch(() => 0);
  }

  // Per-user fields (you / youCreditCents) → keep this response browser-private.
  return json({
    leaderboard: rows, divisions, activeDivisions, xp: xpLeaderboard,
    mvpLeaders, partnerships, kitchen, recentWinners, winnersByEvent,
    you, youCreditCents, hasData: rows.length > 0,
    // When a division was asked for, its scoped values replace the
    // season-wide ones — so the caller reads the same field names either
    // way. `divisions` and `xp` stay whole for the board switcher.
    ...(scoped || {}), division,
  }, 'private, max-age=10');
};

export const config = { path: '/.netlify/functions/public-ladder-stats' };
