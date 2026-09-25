// netlify/functions/lib/pace.js
//
// GAME PACE — how long every game, round and match actually took, built from
// the moment each score was ENTERED (the home captain types it as the game
// ends; the away confirm often lags, sometimes by an hour, so it's never the
// clock). Feeds the admin "Game Pace" tab and The Drop's stats brief.
//
// Timing source per game (first that exists):
//   1. game.timing.enteredAt   — stamped once by captain-score.js the first
//                                time home saves a complete score for the
//                                slot. Never touched by admin edits.
//                                (Or written by admin-pace backfill.)
//   2. game.homeEntry.at       — legacy fallback, ONLY when the entry is a
//                                captain's (an admin override stamps home +
//                                away identically — those are skipped).
//
// Court model: two games run at once. Court A plays games 1,3,5 of each round,
// court B plays 2,4,6 (lib/courts.js courtForGame). A game's length = its
// entry time minus the previous entry on the SAME court. The first game on
// each court is measured from match start (scheduledAt + startOffsetMin), so
// it includes warm-up / a late start — it's flagged `fromStart`.
//
// When a captain enters two games on one court back-to-back (inside
// BATCH_GAP_SEC), the split between them is unknowable: both get half the
// combined span and the `est` flag.
//
// Pure computation lives in computeMatchPace / summarizePace / paceBrief;
// the loaders at the bottom are the only @netlify/blobs users.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './circuit.js';
import { SLOT_KEYS, normalizeScore, gameStatus } from './score-helpers.js';

export const DEFAULT_START_OFFSET_MIN = 5;
const BATCH_GAP_SEC = 75;
const TZ = 'America/Los_Angeles';

export const SLOT_TYPE = {
  r1g1: 'WOMENS', r1g2: 'MENS', r1g3: 'MIXED', r1g4: 'MIXED', r1g5: 'MIXED', r1g6: 'MIXED',
  r2g1: 'WOMENS', r2g2: 'MENS', r2g3: 'MIXED', r2g4: 'MIXED', r2g5: 'MIXED', r2g6: 'MIXED',
};
export const TYPE_LABEL = { WOMENS: "Women's", MENS: "Men's", MIXED: 'Mixed' };
export const COURT_SEQ = {
  A: ['r1g1', 'r1g3', 'r1g5', 'r2g1', 'r2g3', 'r2g5'],
  B: ['r1g2', 'r1g4', 'r1g6', 'r2g2', 'r2g4', 'r2g6'],
};

// ── small helpers ────────────────────────────────────────────────────
const ms = iso => (iso ? new Date(iso).getTime() : null);
const round1 = n => (n == null || !isFinite(n) ? null : Math.round(n * 10) / 10);
const round2 = n => (n == null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function fmtTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}
export function prettySlot(slot) {
  return `R${slot[1]} G${slot.slice(-1)}`;
}
const shortName = n => {
  const parts = String(n || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : (parts[0] || '');
};

// An admin override writes the same { by, at } into both teams' entries.
function isAdminStamp(g) {
  const h = g?.homeEntry, a = g?.awayEntry;
  return !!(h && a && h.at && h.at === a.at && h.by === a.by);
}

/** When the game ended (score entered) and when it was confirmed. */
export function gameTiming(g) {
  const t = g?.timing || {};
  let enteredAt = t.enteredAt || null;
  let confirmedAt = t.confirmedAt || null;
  let source = enteredAt ? (t.source || 'live') : null;
  const admin = isAdminStamp(g);
  if (!enteredAt && g?.homeEntry?.at && !admin) { enteredAt = g.homeEntry.at; source = 'entry'; }
  if (!confirmedAt && g?.awayEntry?.at && !admin) confirmedAt = g.awayEntry.at;
  return { enteredAt, confirmedAt, source, disputes: t.disputes || 0 };
}

function pairOf(lineup, slot) {
  const p = lineup?.games?.[slot];
  if (!p) return { ids: [], names: [] };
  return {
    ids: [p.p1, p.p2].filter(Boolean),
    names: [p.p1Name, p.p2Name].filter(Boolean),
  };
}

// ── one match ────────────────────────────────────────────────────────
/**
 * @param match   schedule match ({ id, teamA, teamB, scheduledAt, courtA, courtB, court, week })
 * @param score   raw score blob (may be null)
 * @param lineups { home, away } lineup blobs (may be null)
 */
export function computeMatchPace(match, score, lineups = {}, opts = {}) {
  const offset = opts.startOffsetMin ?? DEFAULT_START_OFFSET_MIN;
  const startMs = match.scheduledAt ? ms(match.scheduledAt) + offset * 60000 : null;
  const rec = score ? normalizeScore(JSON.parse(JSON.stringify(score)), !!match.championship) : null;
  const games = rec?.games || {};
  const winBy = match.championship ? 2 : 1;

  const out = {};
  for (const slot of SLOT_KEYS) {
    const g = games[slot] || {};
    const status = rec ? gameStatus(g, winBy) : 'empty';
    const tm = gameTiming(g);
    const h = Number.isInteger(g.home) ? g.home : (g.homeEntry?.home ?? null);
    const a = Number.isInteger(g.away) ? g.away : (g.homeEntry?.away ?? null);
    const scored = Number.isInteger(h) && Number.isInteger(a);
    const side = COURT_SEQ.A.includes(slot) ? 'A' : 'B';
    const hp = pairOf(lineups.home, slot), ap = pairOf(lineups.away, slot);
    out[slot] = {
      slot,
      label: prettySlot(slot),
      round: Number(slot[1]),
      gameNo: Number(slot.slice(-1)),
      type: SLOT_TYPE[slot],
      typeLabel: TYPE_LABEL[SLOT_TYPE[slot]],
      side,
      court: (side === 'A' ? match.courtA : match.courtB) || side,
      status,
      home: scored ? h : null,
      away: scored ? a : null,
      winner: scored ? (h > a ? 'home' : a > h ? 'away' : null) : null,
      margin: scored ? Math.abs(h - a) : null,
      points: scored ? h + a : null,
      close: scored ? Math.abs(h - a) <= 3 : null,
      homePair: hp.names, homeIds: hp.ids,
      awayPair: ap.names, awayIds: ap.ids,
      finishedAt: tm.enteredAt,
      confirmedAt: tm.confirmedAt,
      confirmLagMin: tm.enteredAt && tm.confirmedAt ? round1((ms(tm.confirmedAt) - ms(tm.enteredAt)) / 60000) : null,
      disputes: tm.disputes,
      source: tm.source,
      min: null,
      flags: [],
    };
  }

  // Durations per court, in play order.
  for (const side of ['A', 'B']) {
    const seq = COURT_SEQ[side].map(s => out[s]);
    let prevMs = startMs;
    let prevIsStart = true;
    for (let i = 0; i < seq.length; i++) {
      const g = seq[i];
      const t = ms(g.finishedAt);
      if (t == null || prevMs == null) { prevMs = t; prevIsStart = false; continue; }
      const sec = (t - prevMs) / 1000;
      if (sec < 0) { g.flags.push('order'); prevMs = t; prevIsStart = false; continue; }
      g.min = sec / 60;
      if (prevIsStart) g.flags.push('fromStart');
      // Entered right after the previous game on this court → batch entry.
      if (!prevIsStart && sec < BATCH_GAP_SEC && i > 0 && seq[i - 1].min != null) {
        const prev = seq[i - 1];
        const combined = prev.min + g.min;
        prev.min = combined / 2; g.min = combined / 2;
        if (!prev.flags.includes('est')) prev.flags.push('est');
        g.flags.push('est');
      }
      prevMs = t; prevIsStart = false;
    }
  }
  for (const s of SLOT_KEYS) {
    const g = out[s];
    g.min = round1(g.min);
    g.ptsPerMin = g.min && g.points != null ? round2(g.points / g.min) : null;
  }

  const list = SLOT_KEYS.map(s => out[s]);
  const timed = list.filter(g => g.min != null);
  const finMs = list.map(g => ms(g.finishedAt)).filter(Boolean);
  const r1Fin = list.filter(g => g.round === 1).map(g => ms(g.finishedAt)).filter(Boolean);
  const r2Fin = list.filter(g => g.round === 2).map(g => ms(g.finishedAt)).filter(Boolean);
  const finishMs = finMs.length ? Math.max(...finMs) : null;
  const r1End = r1Fin.length === 6 ? Math.max(...r1Fin) : null;
  const r2End = r2Fin.length === 6 ? Math.max(...r2Fin) : null;
  const allTimed = finMs.length === 12;

  // How the home captain enters: per game (spread out) vs per pair (both
  // courts' games saved together) vs batched (several pairs at once).
  const pairGaps = [];
  for (let i = 0; i < 6; i++) {
    const a = ms(out[COURT_SEQ.A[i]].finishedAt), b = ms(out[COURT_SEQ.B[i]].finishedAt);
    if (a && b) pairGaps.push(Math.abs(a - b) / 1000);
  }
  const estCount = list.filter(g => g.flags.includes('est')).length;
  let entryStyle = null;
  if (pairGaps.length >= 3) {
    const together = pairGaps.filter(s => s <= 45).length;
    entryStyle = estCount >= 4 ? 'batched'
      : together >= pairGaps.length * 0.67 ? 'per pair'
      : 'per game';
  }

  const lags = list.map(g => g.confirmLagMin).filter(v => v != null);
  const signHome = rec?.homeSubmittedAt || null, signAway = rec?.awaySubmittedAt || null;
  const adminFinal = !!rec?.finalizedBy;
  const signLag = (at) => (at && finishMs && !adminFinal ? round1((ms(at) - finishMs) / 60000) : null);

  const mins = timed.map(g => g.min);
  const byMin = [...timed].sort((x, y) => x.min - y.min);

  return {
    id: match.id,
    week: match.week,
    division: match.division || null,
    home: { id: match.teamA?.id, name: match.teamA?.name },
    away: { id: match.teamB?.id, name: match.teamB?.name },
    courts: match.court || [match.courtA, match.courtB].filter(Boolean).join(' & '),
    scheduledAt: match.scheduledAt || null,
    startAt: startMs ? new Date(startMs).toISOString() : null,
    finishAt: finishMs ? new Date(finishMs).toISOString() : null,
    totalMin: allTimed && startMs ? round1((finishMs - startMs) / 60000) : null,
    round1Min: r1End && startMs ? round1((r1End - startMs) / 60000) : null,
    round2Min: r1End && r2End ? round1((r2End - r1End) / 60000) : null,
    timedGames: timed.length,
    avgGameMin: round1(mean(mins)),
    medianGameMin: round1(median(mins)),
    // Excluding each court's first game (it carries warm-up / late start).
    avgPlayMin: round1(mean(timed.filter(g => !g.flags.includes('fromStart')).map(g => g.min))),
    ptsPerMin: timed.length ? round2(timed.reduce((a, g) => a + (g.points || 0), 0) / timed.reduce((a, g) => a + g.min, 0)) : null,
    fastest: byMin[0] ? slim(byMin[0]) : null,
    slowest: byMin.length ? slim(byMin[byMin.length - 1]) : null,
    entryStyle,
    confirm: {
      avgLagMin: round1(mean(lags)),
      maxLagMin: lags.length ? Math.max(...lags) : null,
      lateGames: lags.filter(l => l >= 15).length,
      disputes: list.reduce((a, g) => a + (g.disputes || 0), 0),
    },
    signoff: {
      homeAt: signHome, awayAt: signAway,
      homeLagMin: signLag(signHome), awayLagMin: signLag(signAway),
      adminFinalized: adminFinal,
    },
    finalizedAt: rec?.finalizedAt || null,
    complete: allTimed,
    games: list,
  };
}

function slim(g) {
  return {
    slot: g.slot, label: g.label, typeLabel: g.typeLabel, min: g.min,
    home: g.home, away: g.away, margin: g.margin, flags: g.flags,
    homePair: g.homePair, awayPair: g.awayPair,
  };
}

// ── aggregates ───────────────────────────────────────────────────────
function newAgg() {
  return { games: 0, timed: 0, min: 0, pts: 0, mins: [], wins: [], losses: [], close: [], blowout: [], byType: { WOMENS: [], MENS: [], MIXED: [] } };
}
function addGame(agg, g, perspective /* 'home'|'away'|null */) {
  agg.games++;
  if (g.min == null) return;
  agg.timed++; agg.min += g.min; agg.pts += g.points || 0; agg.mins.push(g.min);
  agg.byType[g.type].push(g.min);
  if (g.close) agg.close.push(g.min);
  if (g.margin != null && g.margin >= 8) agg.blowout.push(g.min);
  if (perspective && g.winner) (g.winner === perspective ? agg.wins : agg.losses).push(g.min);
}
function finishAgg(agg) {
  return {
    games: agg.games,
    timedGames: agg.timed,
    courtMin: round1(agg.min),
    avgGameMin: round1(mean(agg.mins)),
    medianGameMin: round1(median(agg.mins)),
    ptsPerMin: agg.min ? round2(agg.pts / agg.min) : null,
    winsAvgMin: round1(mean(agg.wins)),
    lossesAvgMin: round1(mean(agg.losses)),
    closeAvgMin: round1(mean(agg.close)),
    blowoutAvgMin: round1(mean(agg.blowout)),
    byType: Object.fromEntries(Object.entries(agg.byType).map(([k, v]) => [k, { avgMin: round1(mean(v)), n: v.length }])),
  };
}

/** Team and player aggregates over a set of match-pace records. */
export function aggregate(matchPaces) {
  const teams = new Map();
  const players = new Map();
  const league = newAgg();
  const team = (id, name) => {
    if (!teams.has(id)) teams.set(id, { id, name, agg: newAgg(), matchMins: [], r1: [], r2: [], confirmLags: [], signLags: [], styles: [], matches: 0 });
    return teams.get(id);
  };
  const player = (id, name, teamName) => {
    if (!players.has(id)) players.set(id, { id, name, team: teamName, agg: newAgg(), longest: null, record: { w: 0, l: 0 } });
    return players.get(id);
  };

  for (const m of matchPaces) {
    for (const side of ['home', 'away']) {
      const t = team(m[side].id, m[side].name);
      t.matches++;
      if (m.totalMin != null) t.matchMins.push(m.totalMin);
      if (m.round1Min != null) t.r1.push(m.round1Min);
      if (m.round2Min != null) t.r2.push(m.round2Min);
      const lag = m.signoff[side + 'LagMin'];
      if (lag != null) t.signLags.push(lag);
      if (side === 'home' && m.entryStyle) t.styles.push(m.entryStyle);
      if (side === 'away') m.games.forEach(g => { if (g.confirmLagMin != null) t.confirmLags.push(g.confirmLagMin); });
      m.games.forEach(g => addGame(t.agg, g, side));
    }
    for (const g of m.games) {
      addGame(league, g, null);
      for (const side of ['home', 'away']) {
        const ids = g[side + 'Ids'], names = g[side + 'Pair'];
        ids.forEach((id, i) => {
          const p = player(id, names[i] || id, m[side].name);
          addGame(p.agg, g, side);
          if (g.winner) g.winner === side ? p.record.w++ : p.record.l++;
          if (g.min != null && (!p.longest || g.min > p.longest.min)) {
            p.longest = { min: g.min, label: g.label, week: m.week, score: `${g[side]}–${g[side === 'home' ? 'away' : 'home']}` };
          }
        });
      }
    }
  }

  const leagueOut = finishAgg(league);
  const teamsOut = [...teams.values()].map(t => {
    const a = finishAgg(t.agg);
    return {
      id: t.id, name: t.name, matches: t.matches,
      avgMatchMin: round1(mean(t.matchMins)),
      avgRound1Min: round1(mean(t.r1)),
      avgRound2Min: round1(mean(t.r2)),
      ...a,
      vsLeagueMin: a.avgGameMin != null && leagueOut.avgGameMin != null ? round1(a.avgGameMin - leagueOut.avgGameMin) : null,
      avgConfirmLagMin: round1(mean(t.confirmLags)),
      avgSignoffLagMin: round1(mean(t.signLags)),
      entryStyle: t.styles.length ? mode(t.styles) : null,
    };
  }).sort((x, y) => (x.avgGameMin ?? 99) - (y.avgGameMin ?? 99));

  const playersOut = [...players.values()].map(p => ({
    id: p.id, name: p.name, team: p.team,
    record: p.record,
    longest: p.longest,
    ...finishAgg(p.agg),
  })).sort((x, y) => (y.courtMin ?? 0) - (x.courtMin ?? 0));

  return { league: leagueOut, teams: teamsOut, players: playersOut };
}

function mode(arr) {
  const c = {};
  arr.forEach(v => { c[v] = (c[v] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}

/** Everything for one week: matches + aggregates + night summary + insights. */
export function summarizePace(matchPaces, seasonPaces = null) {
  const agg = aggregate(matchPaces);
  const allGames = matchPaces.flatMap(m => m.games.map(g => ({ ...g, match: `${m.home.name} v ${m.away.name}`, homeName: m.home.name, awayName: m.away.name })));
  const timed = allGames.filter(g => g.min != null).sort((a, b) => a.min - b.min);
  const starts = matchPaces.map(m => ms(m.startAt)).filter(Boolean);
  const fins = matchPaces.map(m => ms(m.finishAt)).filter(Boolean);
  const done = matchPaces.filter(m => m.totalMin != null).sort((a, b) => a.totalMin - b.totalMin);

  const night = {
    startAt: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
    lastFinishAt: fins.length ? new Date(Math.max(...fins)).toISOString() : null,
    matches: matchPaces.length,
    timedGames: timed.length,
    totalGames: allGames.length,
    avgMatchMin: round1(mean(done.map(m => m.totalMin))),
    ...agg.league,
    fastestMatch: done[0] ? { id: done[0].id, teams: `${done[0].home.name} v ${done[0].away.name}`, totalMin: done[0].totalMin } : null,
    slowestMatch: done.length ? { id: done[done.length - 1].id, teams: `${done[done.length - 1].home.name} v ${done[done.length - 1].away.name}`, totalMin: done[done.length - 1].totalMin } : null,
    avgConfirmLagMin: round1(mean(allGames.map(g => g.confirmLagMin).filter(v => v != null))),
  };

  const season = seasonPaces ? aggregate(seasonPaces) : null;
  const out = {
    night,
    matches: matchPaces,
    teams: agg.teams,
    players: agg.players,
    fastestGames: timed.filter(g => !g.flags.includes('fromStart')).slice(0, 5).map(gameLine),
    slowestGames: timed.slice(-5).reverse().map(gameLine),
    season: season ? { league: season.league, teams: season.teams, players: season.players.slice(0, 25) } : null,
  };
  out.insights = buildInsights(out);
  return out;
}

function gameLine(g) {
  return {
    slot: g.slot, label: g.label, typeLabel: g.typeLabel, match: g.match, min: g.min, flags: g.flags,
    score: `${g.homeName} ${g.home}–${g.away} ${g.awayName}`,
    homePair: g.homePair, awayPair: g.awayPair, margin: g.margin, ptsPerMin: g.ptsPerMin,
  };
}

const pairTxt = names => names.map(shortName).join(' & ');

/** Plain-English, fact-only lines — safe to drop straight into The Drop brief. */
export function buildInsights(p) {
  const out = [];
  const n = p.night;
  if (!n.timedGames) return out;
  if (n.startAt && n.lastFinishAt) {
    out.push(`The night ran ${fmtTime(n.startAt)}–${fmtTime(n.lastFinishAt)}. Average game: ${n.avgGameMin} min (median ${n.medianGameMin}), ${n.ptsPerMin} rally points a minute.`);
  }
  if (n.fastestMatch && n.slowestMatch && n.fastestMatch.id !== n.slowestMatch.id) {
    out.push(`Fastest match: ${n.fastestMatch.teams} in ${n.fastestMatch.totalMin} min. Longest: ${n.slowestMatch.teams} at ${n.slowestMatch.totalMin} min — ${round1(n.slowestMatch.totalMin - n.fastestMatch.totalMin)} min more court time for the same 12 games.`);
  }
  const sl = p.slowestGames[0];
  if (sl) out.push(`Longest game: ${sl.label} ${sl.typeLabel} (${sl.match}), ${sl.score}, ${sl.min} min${sl.homePair.length ? ` — ${pairTxt(sl.homePair)} vs ${pairTxt(sl.awayPair)}` : ''}${sl.flags.includes('fromStart') ? ' (first game of the night, includes warm-up)' : ''}.`);
  const fa = p.fastestGames[0];
  if (fa) out.push(`Quickest game: ${fa.label} ${fa.typeLabel} (${fa.match}), ${fa.score}, done in ${fa.min} min.`);
  const bt = n.byType;
  if (bt && bt.WOMENS.n && bt.MENS.n && bt.MIXED.n) {
    out.push(`By game type: women's ${bt.WOMENS.avgMin} min, men's ${bt.MENS.avgMin} min, mixed ${bt.MIXED.avgMin} min on average.`);
  }
  if (n.closeAvgMin != null && n.blowoutAvgMin != null) {
    out.push(`Games decided by 3 or fewer took ${n.closeAvgMin} min on average; blowouts (8+) took ${n.blowoutAvgMin} min.`);
  }
  const tempo = p.matches.filter(m => m.ptsPerMin != null).sort((a, b) => b.ptsPerMin - a.ptsPerMin);
  if (tempo.length >= 2) {
    const hi = tempo[0], lo = tempo[tempo.length - 1];
    const pts = m => m.games.reduce((a, g) => a + (g.min != null ? g.points || 0 : 0), 0);
    if (hi.ptsPerMin - lo.ptsPerMin < 0.1) {
      const byLen = [...tempo].filter(m => m.totalMin != null).sort((a, b) => a.totalMin - b.totalMin);
      if (byLen.length >= 2) {
        const f = byLen[0], l = byLen[byLen.length - 1];
        out.push(`Every match played at nearly the same speed (${lo.ptsPerMin}–${hi.ptsPerMin} rally points a minute), so match length came down to how close the games were: ${f.home.name} v ${f.away.name} played ${pts(f)} points, ${l.home.name} v ${l.away.name} played ${pts(l)}.`);
      }
    }
    out.push(`Tempo: ${hi.home.name} v ${hi.away.name} moved at ${hi.ptsPerMin} rally points a minute (avg ${hi.avgGameMin} min a game); ${lo.home.name} v ${lo.away.name} was the grind at ${lo.ptsPerMin} (${lo.avgGameMin} min a game).`);
  }
  const rounds = p.matches.filter(m => m.round1Min != null && m.round2Min != null);
  if (rounds.length) {
    const faster = rounds.filter(m => m.round2Min < m.round1Min).length;
    out.push(`Round 2 was quicker than round 1 in ${faster} of ${rounds.length} match${rounds.length === 1 ? '' : 'es'}.`);
  }
  const iron = p.players.filter(x => x.courtMin);
  if (iron.length) out.push(`Most court time: ${iron[0].name} (${iron[0].team}) — ${iron[0].courtMin} min across ${iron[0].games} games.`);
  const lagTeams = p.teams.filter(t => t.avgConfirmLagMin != null && t.avgConfirmLagMin >= 15);
  lagTeams.forEach(t => out.push(`${t.name} took ${t.avgConfirmLagMin} min on average to confirm scores.`));
  return out.map(t => t.replace(/\.\.$/, '.').replace(/\.\)\.$/, '.).'));
}

/** Compact version for the Drop generator prompt. */
export function paceBrief(p) {
  if (!p || !p.night?.timedGames) return null;
  return {
    note: 'Minutes per game come from when the home captain entered each score (two games run at once, one per court). The first game on each court includes warm-up. Approximate — use as texture, not gospel.',
    night: {
      ran: p.night.startAt && p.night.lastFinishAt ? `${fmtTime(p.night.startAt)}–${fmtTime(p.night.lastFinishAt)}` : null,
      avgGameMin: p.night.avgGameMin, medianGameMin: p.night.medianGameMin, ptsPerMin: p.night.ptsPerMin,
      byType: p.night.byType, closeAvgMin: p.night.closeAvgMin, blowoutAvgMin: p.night.blowoutAvgMin,
    },
    matches: p.matches.map(m => ({
      match: `${m.home.name} v ${m.away.name}`, totalMin: m.totalMin, round1Min: m.round1Min, round2Min: m.round2Min,
      avgGameMin: m.avgGameMin, fastest: m.fastest && `${m.fastest.label} ${m.fastest.home}–${m.fastest.away} (${m.fastest.min} min)`,
      slowest: m.slowest && `${m.slowest.label} ${m.slowest.home}–${m.slowest.away} (${m.slowest.min} min)`,
    })),
    teams: p.teams.map(t => {
      const s = p.season?.teams.find(x => x.id === t.id);
      return { team: t.name, avgGameMin: t.avgGameMin, ptsPerMin: t.ptsPerMin, winsAvgMin: t.winsAvgMin, lossesAvgMin: t.lossesAvgMin, seasonAvgGameMin: s?.avgGameMin ?? null };
    }),
    longestGames: p.slowestGames.slice(0, 3),
    quickestGames: p.fastestGames.slice(0, 3),
    mostCourtTime: p.players.slice(0, 5).map(x => ({ name: x.name, team: x.team, courtMin: x.courtMin, games: x.games })),
    insights: p.insights,
  };
}

// ── loaders (blob-backed) ────────────────────────────────────────────
/** All scheduled matches for a circuit, grouped by week: Map<week, match[]> */
export async function loadScheduleByWeek(circuit) {
  const code = circuitCode(circuit);
  const store = getStore({ name: 'schedule', consistency: 'strong' });
  const { blobs } = await store.list({ prefix: `schedule/${code}/` }).catch(() => ({ blobs: [] }));
  const byWeek = new Map();
  for (const b of blobs) {
    const data = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const week = Number(data.week);
    for (const m of data.matches) {
      if (!m?.id || !m.teamA?.id || !m.teamB?.id) continue; // bracket placeholders
      if (!byWeek.has(week)) byWeek.set(week, []);
      byWeek.get(week).push({ ...m, week, division: data.division, circuit: code });
    }
  }
  return byWeek;
}

export async function loadMatchPace(match, opts = {}) {
  const scores = getStore({ name: 'scores', consistency: 'strong' });
  const lineups = getStore('lineups');
  const [score, home, away] = await Promise.all([
    scores.get(`score/${match.id}.json`, { type: 'json' }).catch(() => null),
    lineups.get(`lineup/${match.id}/${match.teamA.id}.json`, { type: 'json' }).catch(() => null),
    lineups.get(`lineup/${match.id}/${match.teamB.id}.json`, { type: 'json' }).catch(() => null),
  ]);
  if (!score) return null;
  return computeMatchPace(match, score, { home, away }, opts);
}

/**
 * Pace for a week (+ season-to-date through that week).
 * week omitted → the latest week that has any timed game.
 */
export async function loadPace(circuit, week = null, opts = {}) {
  const code = circuitCode(circuit);
  const byWeek = await loadScheduleByWeek(code);
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  const perWeek = new Map();
  for (const w of weeks) {
    const ps = (await Promise.all(byWeek.get(w).map(m => loadMatchPace(m, opts)))).filter(p => p && p.timedGames > 0);
    if (ps.length) perWeek.set(w, ps);
  }
  const timedWeeks = [...perWeek.keys()];
  const target = week ? Number(week) : (timedWeeks.length ? timedWeeks[timedWeeks.length - 1] : null);
  if (!target || !perWeek.has(target)) {
    return { circuit: code, week: target, weeks: timedWeeks, empty: true };
  }
  const seasonPaces = timedWeeks.filter(w => w <= target).flatMap(w => perWeek.get(w));
  const summary = summarizePace(perWeek.get(target), seasonPaces);
  return { circuit: code, week: target, weeks: timedWeeks, startOffsetMin: opts.startOffsetMin ?? DEFAULT_START_OFFSET_MIN, ...summary };
}
