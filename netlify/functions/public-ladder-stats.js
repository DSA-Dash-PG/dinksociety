// netlify/functions/public-ladder-stats.js
// GET /api/public-ladder-stats          → season DR leaderboard + recent winners
// GET /api/public-ladder-stats?event=ID → that night's standings + podium
//
// Powers the Stats tab on /ladders and the front-page winners. Uses the ported
// engine (lib/ladder-scoring.js) over play data (lib/ladder-play.js), so DR and
// stats are identical to Pickleladder. If a player session is present, includes
// a `you` summary.

import { verifyPlayerSession } from './lib/auth.js';
import { getEvent } from './lib/ladder.js';
import { getPlay, listPlay, toSession, playersFromPlay } from './lib/ladder-play.js';
import { calcStats, calcDinkRating, calcBonusPts } from './lib/ladder-scoring.js';

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' } });
}

// Top-3 finishers for a single session (by points, then diff — same as bonus).
function podium(stats) {
  return stats.slice(0, 3).map((s, i) => ({ rank: i + 1, id: s.id, name: s.name, pf: s.pf, diff: s.pf - s.pa, w: s.w, l: s.l }));
}

export default async (req) => {
  const eventId = new URL(req.url).searchParams.get('event');

  // ── one night ──
  if (eventId) {
    const event = await getEvent(eventId);
    const play = await getPlay(eventId);
    if (!play) return json({ event: event ? { id: event.id, name: event.name } : null, standings: [], winners: [] });
    const sessions = [toSession(play)];
    const players = playersFromPlay([play]);
    const stats = calcStats(sessions, players);
    const dr = calcDinkRating(stats, sessions, players);
    const standings = stats.map(s => ({ id: s.id, name: s.name, gender: s.gender, w: s.w, l: s.l, pf: s.pf, pa: s.pa, dr: dr[s.id] }));
    return json({ event: event ? { id: event.id, name: event.name, date: event.date } : null, standings, winners: podium(stats) });
  }

  // ── season-wide ──
  const plays = await listPlay();
  const sessions = plays.map(toSession);
  const players = playersFromPlay(plays);
  const stats = calcStats(sessions, players);
  const dr = calcDinkRating(stats, sessions, players);
  const bonus = calcBonusPts(sessions, players);

  const leaderboard = stats
    .map(s => ({ id: s.id, name: s.name, gender: s.gender, dr: dr[s.id], w: s.w, l: s.l, pf: s.pf, nights: s.attended, podiums: (bonus[s.id]?.ladderResults || []).filter(r => r.rank <= 3).length }))
    .sort((a, b) => (b.dr ?? -1) - (a.dr ?? -1));

  // most recent night's winners
  let recent = null;
  if (plays.length) {
    const latest = plays.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))[0];
    const ls = [toSession(latest)];
    const lstats = calcStats(ls, playersFromPlay([latest]));
    const ev = await getEvent(latest.eventId).catch(() => null);
    recent = { eventId: latest.eventId, eventName: ev?.name || null, date: latest.date, winners: podium(lstats) };
  }

  // optional "you"
  let you = null;
  const v = await verifyPlayerSession(req);
  if (v.valid) {
    const me = leaderboard.find(r => r.id === v.payload.playerId);
    if (me) you = { id: me.id, dr: me.dr, w: me.w, l: me.l, nights: me.nights, podiums: me.podiums };
  }

  return json({ leaderboard, recent, you });
};

export const config = { path: '/.netlify/functions/public-ladder-stats' };
