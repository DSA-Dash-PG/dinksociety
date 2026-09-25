// netlify/functions/public-pace.js
//
// PUBLIC endpoint — no auth. Game pace, three shapes:
//
//   GET ?circuit=II[&week=N]        → { circuit, week, weeks, brief }
//        One week in The Drop's brief shape (lib/pace.js paceBrief + stories).
//        Used by the Friday Drop writer (WebFetch can't sign in to admin-pace).
//   GET ?circuit=II&view=season     → { circuit, weeks, league, teams, courtTime,
//                                       longestGames, quickestGames, clutchGames, matches }
//        Season to date. Powers the NVZ "Game Pace" tab.
//   GET ?circuit=II&team=<name|slug> → { circuit, weeks, team, league, rank, of,
//                                       matches, quickestWin, longestGame, courtTime }
//        One team's season pace. Powers the Game Pace card on the team page.
//
// Minutes are approximate — they come from score-entry times. `approx: true`
// marks games from a match whose scores were entered two at a time (the paired
// games share one time). Admin-only bits (score-confirm lag, sign-off timing,
// entry style) never leave this endpoint.

import { liveCircuit } from './lib/current-season.js';
import { circuitCode } from './lib/circuit.js';
import { loadPace, paceBrief, aggregate, matchResult } from './lib/pace.js';
import { etagJson } from './lib/http-cache.js';

const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const shortName = n => { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : (p[0] || ''); };
const pair = a => (a || []).map(shortName).join(' & ');

function cleanTeam(t) {
  if (!t) return null;
  const { avgConfirmLagMin, avgSignoffLagMin, entryStyle, ...rest } = t;
  return rest;
}
function isApprox(m) { return m.entryStyle === 'per pair' || m.entryStyle === 'batched'; }

// Flat list of every timed game in the season, with its match context.
function seasonGames(matches) {
  return matches.flatMap(m => m.games.filter(g => g.min != null && g.home != null).map(g => ({
    week: m.week, match: `${m.home.name} v ${m.away.name}`, homeName: m.home.name, awayName: m.away.name,
    homeId: m.home.id, awayId: m.away.id,
    slot: g.slot, label: g.label, type: g.typeLabel, home: g.home, away: g.away, winner: g.winner, margin: g.margin,
    min: g.min, warmup: g.flags.includes('fromStart'), approx: isApprox(m),
    homePair: pair(g.homePair), awayPair: pair(g.awayPair),
  })));
}
function gameOut(g, forTeamId = null) {
  const winName = g.winner === 'home' ? g.homeName : g.awayName;
  const loseName = g.winner === 'home' ? g.awayName : g.homeName;
  const hi = Math.max(g.home, g.away), lo = Math.min(g.home, g.away);
  const out = {
    week: g.week, match: g.match, slot: g.slot, label: g.label, type: g.type, min: g.min, approx: g.approx,
    score: `${hi}–${lo}`, winner: winName, loser: loseName,
    winPair: g.winner === 'home' ? g.homePair : g.awayPair, losePair: g.winner === 'home' ? g.awayPair : g.homePair,
  };
  if (forTeamId) {
    const side = g.homeId === forTeamId ? 'home' : 'away';
    out.won = g.winner === side;
    out.opponent = side === 'home' ? g.awayName : g.homeName;
    out.teamScore = `${g[side]}–${g[side === 'home' ? 'away' : 'home']}`;
    out.teamPair = g[side + 'Pair'];
  }
  return out;
}
function playersOut(list) {
  return list.filter(p => p.courtMin).map(p => ({
    name: p.name, team: p.team, courtMin: p.courtMin, games: p.games, avgGameMin: p.avgGameMin, record: p.record,
  }));
}

export default async (req) => {
  const url = new URL(req.url);
  try {
    const circuit = url.searchParams.get('circuit') ? circuitCode(url.searchParams.get('circuit')) : await liveCircuit();
    const view = url.searchParams.get('view') || '';
    const teamParam = String(url.searchParams.get('team') || '').trim();

    // ── one week, Drop brief shape ──
    if (!view && !teamParam) {
      const pace = await loadPace(circuit, url.searchParams.get('week') || null);
      if (pace.empty) return etagJson(req, { circuit: pace.circuit, week: pace.week, weeks: pace.weeks, brief: null, message: 'No timed games for that week yet.' });
      const brief = paceBrief(pace);
      if (brief) brief.insights = (brief.insights || []).filter(t => !/to confirm scores/i.test(t));
      return etagJson(req, { circuit: pace.circuit, week: pace.week, weeks: pace.weeks, brief });
    }

    // ── season to date (NVZ tab / team page) ──
    const pace = await loadPace(circuit, null, { withSeason: true });
    if (pace.empty) return etagJson(req, { circuit: pace.circuit, weeks: pace.weeks || [], empty: true, message: 'No timed games yet.' });
    const matches = pace.seasonMatches || [];
    const agg = aggregate(matches);
    const teams = agg.teams.map(cleanTeam);
    const games = seasonGames(matches);
    const play = games.filter(g => !g.warmup);   // each court's first game carries warm-up
    const matchList = matches.map(m => {
      const r = matchResult(m);
      return { week: m.week, home: m.home.name, away: m.away.name, homeId: m.home.id, awayId: m.away.id, winner: r.winner,
        games: `${r.homeGames}–${r.awayGames}`, points: `${r.homePts}–${r.awayPts}`, pointsPlayed: r.homePts + r.awayPts,
        totalMin: m.totalMin, round1Min: m.round1Min, round2Min: m.round2Min, avgGameMin: m.avgGameMin };
    }).sort((a, b) => a.week - b.week);

    if (!teamParam) {
      return etagJson(req, {
        circuit: pace.circuit, weeks: pace.weeks, league: agg.league, teams,
        courtTime: playersOut(agg.players).slice(0, 15),
        longestGames: [...play].sort((a, b) => b.min - a.min).slice(0, 8).map(g => gameOut(g)),
        quickestGames: [...play].sort((a, b) => a.min - b.min).slice(0, 8).map(g => gameOut(g)),
        clutchGames: games.filter(g => g.margin != null && g.margin <= 2).sort((a, b) => b.min - a.min).slice(0, 8).map(g => gameOut(g)),
        matches: matchList,
      });
    }

    const want = slug(teamParam);
    const t = teams.find(x => slug(x.name) === want);
    if (!t) return etagJson(req, { circuit: pace.circuit, weeks: pace.weeks, team: null, message: 'No timed games for that team yet.' });
    const byPace = [...teams].filter(x => x.avgGameMin != null).sort((a, b) => a.avgGameMin - b.avgGameMin);
    const mine = play.filter(g => g.homeId === t.id || g.awayId === t.id);
    const side = g => (g.homeId === t.id ? 'home' : 'away');
    const wins = mine.filter(g => g.winner === side(g)).sort((a, b) => a.min - b.min);
    const longest = [...mine].sort((a, b) => b.min - a.min)[0];
    const clutch = mine.filter(g => g.margin != null && g.margin <= 2).sort((a, b) => b.min - a.min)[0];
    return etagJson(req, {
      circuit: pace.circuit, weeks: pace.weeks,
      team: t, league: agg.league,
      rank: byPace.findIndex(x => x.id === t.id) + 1, of: byPace.length,   // 1 = quickest games
      matches: matchList.filter(m => m.homeId === t.id || m.awayId === t.id).map(m => {
        const home = m.homeId === t.id;
        return { week: m.week, opponent: home ? m.away : m.home, result: m.winner ? (m.winner === t.name ? 'W' : 'L') : 'T',
          games: home ? m.games : m.games.split('–').reverse().join('–'), totalMin: m.totalMin,
          round1Min: m.round1Min, round2Min: m.round2Min, avgGameMin: m.avgGameMin, pointsPlayed: m.pointsPlayed };
      }),
      quickestWin: wins[0] ? gameOut(wins[0], t.id) : null,
      longestGame: longest ? gameOut(longest, t.id) : null,
      longestClutch: clutch ? gameOut(clutch, t.id) : null,
      courtTime: playersOut(agg.players.filter(p => p.team === t.name)),
    });
  } catch (err) {
    console.error('public-pace error:', err);
    return etagJson(req, { brief: null, message: 'Game pace is unavailable right now.' });
  }
};

export const config = { path: '/.netlify/functions/public-pace' };
