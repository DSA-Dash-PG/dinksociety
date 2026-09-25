// netlify/functions/lib/ohana-core.js
// Pure logic for the private South Bay Ohana page (/ohana) — our team's run in
// the PVTC Fall 2026 3.5 Mixed mini league. No I/O here so it can be unit-tested.
//
// This league lives in its OWN blob store (`private-leagues`, key
// `league/ohana.json`), not in `teams`/`seasons`. That is what keeps it off
// every public page: nothing that builds the leaderboard, standings, player
// careers, DSR, The Drop or recaps ever reads that store.
//
// Shape (see seedLeague):
//   { slug, name, ourTeamId, venue, night, defaultTime, gamesPerMatch,
//     teams:[{id,name}], roster:[{email,name,manager,addedAt}],
//     weeks:[{id,label,date,type,note,matches:[match]}], sent:{}, log:[] }
//   match = { id, home:{teamId,label}, away:{teamId,label}, courts, time,
//             counts, note, result:{home,away}|null,
//             slots:[{no, players:[email,email], opp:[name,name], us, them}],
//             avail:{email:'in'|'out'}, lineupSentAt, lineupSnapshot }
// Per-game detail (slots) only exists for OUR matches. For everyone else we
// only record final games won — `result` — which is enough for standings.

export const SLUG = 'ohana';
export const OUR_TEAM_ID = 'south-bay-ohana';
export const GAMES_PER_MATCH = 12;

const TEAMS = [
  ['south-bay-ohana', 'South Bay Ohana'],
  ['dink-life', 'Dink Life'],
  ['net-flicks', 'Net Flicks'],
  ['pickle-juice', 'Pickle Juice'],
  ['aceholes', 'AceHoles'],
];

const C1 = '12-1, 12-2';
const C2 = '12-3, 12-4';
const t = (id) => ({ teamId: id, label: '' });
const seed = (label) => ({ teamId: null, label });

function mk(weekId, n, home, away, courts, extra = {}) {
  return {
    id: `${weekId}-m${n}`, home, away, courts, time: '7:00 PM', counts: true, note: '',
    result: null, slots: [], avail: {}, lineupSentAt: null, lineupSnapshot: null, ...extra,
  };
}

/** The schedule exactly as PVTC published it (Fall 2026, 3.5 Mixed, Tuesdays 7–9pm). */
export function seedLeague() {
  const w = (id, label, date, type, matches, note = '') => ({ id, label, date, type, note, matches });
  return {
    slug: SLUG,
    name: 'PVTC Fall 2026 · 3.5 Mixed',
    ourTeamId: OUR_TEAM_ID,
    venue: 'PVTC',
    night: 'Tuesdays 7–9pm',
    defaultTime: '7:00 PM',
    gamesPerMatch: GAMES_PER_MATCH,
    teams: TEAMS.map(([id, name]) => ({ id, name })),
    roster: [],
    weeks: [
      w('w1', 'Week 1', '2026-09-29', 'regular', [
        mk('w1', 1, t('net-flicks'), t('dink-life'), C1),
        mk('w1', 2, t('pickle-juice'), t('aceholes'), C2),
      ]),
      w('w2', 'Week 2', '2026-10-06', 'regular', [
        mk('w2', 1, t('dink-life'), t('pickle-juice'), C1),
        mk('w2', 2, t('aceholes'), t('south-bay-ohana'), C2),
      ]),
      w('w3', 'Week 3', '2026-10-13', 'regular', [
        mk('w3', 1, t('aceholes'), t('dink-life'), C1),
        mk('w3', 2, t('south-bay-ohana'), t('net-flicks'), C2),
      ]),
      w('w4', 'Week 4', '2026-10-20', 'regular', [
        mk('w4', 1, t('pickle-juice'), t('net-flicks'), C1),
        mk('w4', 2, t('dink-life'), t('south-bay-ohana'), C2),
      ]),
      w('w5', 'Week 5', '2026-10-27', 'regular', [
        mk('w5', 1, t('south-bay-ohana'), t('pickle-juice'), C1),
        mk('w5', 2, t('net-flicks'), t('aceholes'), C2),
      ]),
      w('w6', 'Week 6 · Round Robin', '2026-11-03', 'roundrobin', [
        mk('w6', 1, t('net-flicks'), t('dink-life'), C1),
        mk('w6', 2, t('pickle-juice'), t('aceholes'), C2),
        mk('w6', 3, t('south-bay-ohana'), t('net-flicks'), '11-3, 11-4'),
      ], 'Round robin — separate format.'),
      w('rain', 'Rain date', '2026-11-10', 'rain', [], 'Extra week in the schedule for rain makeups.'),
      w('semis', 'Playoffs · Semis', '2026-11-17', 'semis', [
        mk('semis', 1, seed('2nd seed'), seed('3rd seed'), C1, { note: 'Semi #1' }),
        mk('semis', 2, seed('4th seed'), seed('5th seed'), C2, { note: 'Semi #2' }),
      ], '1st place gets a bye in the semis. Loser of Semi #2 does not play in the finals.'),
      w('finals', 'Playoffs · Finals', '2026-12-01', 'finals', [
        mk('finals', 1, seed('1st seed'), seed('Winner Semi #1'), C1, { note: 'Championship' }),
        mk('finals', 2, seed('Winner Semi #2'), seed('Loser Semi #1'), C2, { note: '3rd place game' }),
      ]),
    ],
    sent: {},
    log: [],
    createdAt: new Date().toISOString(),
  };
}

// ── Lookups ──────────────────────────────────────────────────────────────
export function teamName(league, side) {
  if (!side) return 'TBD';
  if (side.teamId) return league.teams.find(x => x.id === side.teamId)?.name || side.teamId;
  return side.label || 'TBD';
}
export function isOurs(league, m) {
  const us = league.ourTeamId;
  return m?.home?.teamId === us || m?.away?.teamId === us;
}
/** 'home' | 'away' | null — which side we're on. */
export function ourSide(league, m) {
  if (m?.home?.teamId === league.ourTeamId) return 'home';
  if (m?.away?.teamId === league.ourTeamId) return 'away';
  return null;
}
export function opponentOf(league, m) {
  const s = ourSide(league, m);
  if (!s) return null;
  return s === 'home' ? m.away : m.home;
}
export function allMatches(league) {
  const out = [];
  for (const wk of league.weeks || []) for (const m of wk.matches || []) out.push({ week: wk, match: m });
  return out;
}
export function findMatch(league, id) {
  return allMatches(league).find(x => x.match.id === id) || null;
}
/** Weeks where we have no match but the league plays (Week 1, etc.). */
/** A match can be moved off its week's night (rain, court swap). */
export function matchDate(wk, m) { return (m && m.date) || wk.date; }

export function isByeWeek(league, wk) {
  if (!['regular', 'roundrobin'].includes(wk.type)) return false;
  return !(wk.matches || []).some(m => isOurs(league, m));
}

// ── Time (America/Los_Angeles) ───────────────────────────────────────────
/** "7:00 PM" | "19:00" → [h, m] */
export function parseTime(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return [19, 0];
  let h = +m[1]; const min = +(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap.startsWith('p') && h < 12) h += 12;
  if (ap.startsWith('a') && h === 12) h = 0;
  return [h, min];
}
/** Epoch ms for a wall-clock time in Los Angeles on YYYY-MM-DD. */
export function laMs(dateStr, time = '7:00 PM') {
  const [y, mo, d] = String(dateStr).split('-').map(Number);
  const [h, mi] = parseTime(time);
  let guess = Date.UTC(y, mo - 1, d, h + 8, mi); // PST first
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const seenUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    const wantUtc = Date.UTC(y, mo - 1, d, h, mi);
    guess += wantUtc - seenUtc;
  }
  return guess;
}
export function dateLine(dateStr, time) {
  const ms = laMs(dateStr, '12:00 PM');
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(ms));
  return time ? `${day} · ${time}` : day;
}

// ── Match format (PVTC rules) ─────────────────────────────────────────────
// 2 rounds of 6 games. Each round, per the PVTC Mixed scoresheet:
// Game 1 women's doubles, Game 2 men's doubles, Games 3–6 mixed.
// Round 1: home serves first, away chooses side. Round 2: home chooses side,
// away serves first. Standings points are awarded PER ROUND:
// 2 for winning the round (more games), 1 for a tie (3-3), 0 for a loss.
export const GAMES_PER_ROUND = 6;
const ROUND_TYPES = ['WD', 'MD', 'MXD', 'MXD', 'MXD', 'MXD'];
export const TYPE_LABEL = { MD: "Men's", WD: "Women's", MXD: 'Mixed' };
export const roundOf = (no) => (no <= GAMES_PER_ROUND ? 1 : 2);
export const typeOf = (no) => ROUND_TYPES[(no - 1) % GAMES_PER_ROUND];
export function roundPoints(a, b) {
  if (!(a + b)) return [0, 0];
  return a > b ? [2, 0] : a < b ? [0, 2] : [1, 1];
}

// ── Lineup slots ─────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; }
export function normSlots(slots, n = GAMES_PER_MATCH) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = (slots || []).find(x => Number(x?.no) === i + 1) || (slots || [])[i] || {};
    const players = [0, 1].map(j => String(s.players?.[j] || '').trim().toLowerCase());
    const opp = [0, 1].map(j => String(s.opp?.[j] || '').trim().slice(0, 60));
    out.push({ no: i + 1, round: roundOf(i + 1), type: typeOf(i + 1), players, opp, us: num(s.us), them: num(s.them) });
  }
  return out;
}
export function slotScored(s) { return s && s.us != null && s.them != null && s.us !== s.them; }

/**
 * Full result of a match, or null:
 *   { home, away }                 total games won
 *   rounds: [{ home, away }, ...]  games won per round
 *   ptsHome, ptsAway               standings points (2/1/0 per round, max 4)
 *   scoredHome, scoredAway         rally points scored (tiebreak) or null
 *   source: 'games' | 'final'
 * Our matches roll up from game scores when any are entered; otherwise from
 * the final sheet entered as `result: { r1:{home,away}, r2:{home,away}, pts? }`.
 */
export function matchResult(league, m) {
  const side = ourSide(league, m);
  let rounds, scored = null, source;
  if (side && (m.slots || []).some(slotScored)) {
    const slots = normSlots(m.slots);
    const tally = [1, 2].map(r => {
      let us = 0, them = 0;
      for (const s of slots) if (s.round === r && slotScored(s)) (s.us > s.them ? us++ : them++);
      return side === 'home' ? { home: us, away: them } : { home: them, away: us };
    });
    let pu = 0, pt = 0;
    for (const s of slots) if (slotScored(s)) { pu += s.us; pt += s.them; }
    scored = side === 'home' ? { home: pu, away: pt } : { home: pt, away: pu };
    rounds = tally; source = 'games';
  } else {
    const r = m.result;
    if (!r) return null;
    const rr = (x) => x && Number.isFinite(+x.home) && Number.isFinite(+x.away) ? { home: +x.home, away: +x.away } : null;
    if (r.r1 || r.r2) rounds = [rr(r.r1), rr(r.r2)].filter(Boolean);
    else if (rr(r)) rounds = [rr(r)]; // legacy single total — counted as one round
    else return null;
    if (r.pts && Number.isFinite(+r.pts.home) && Number.isFinite(+r.pts.away)) scored = { home: +r.pts.home, away: +r.pts.away };
    source = 'final';
  }
  rounds = rounds.filter(x => x.home + x.away > 0);
  if (!rounds.length) return null;
  let ph = 0, pa = 0, h = 0, a = 0;
  for (const x of rounds) { const [p, q] = roundPoints(x.home, x.away); ph += p; pa += q; h += x.home; a += x.away; }
  return { home: h, away: a, rounds, ptsHome: ph, ptsAway: pa, scoredHome: scored?.home ?? null, scoredAway: scored?.away ?? null, source };
}

// ── Standings ────────────────────────────────────────────────────────────
// PVTC: teams advance on points accumulated in the regular season. Ties:
// head-to-head, then games won overall, then total points scored.
export function computeStandings(league) {
  const rows = new Map(league.teams.map(tm => [tm.id, { teamId: tm.id, name: tm.name, mp: 0, mw: 0, ml: 0, mt: 0, pts: 0, gw: 0, gl: 0, ps: 0, pa: 0 }]));
  const h2h = new Map(); // `${a}|${b}` → points a earned vs b
  for (const { week, match } of allMatches(league)) {
    if (!['regular', 'roundrobin'].includes(week.type) || match.counts === false) continue;
    const r = matchResult(league, match);
    const hId = match.home?.teamId, aId = match.away?.teamId;
    const h = rows.get(hId), a = rows.get(aId);
    if (!r || !h || !a) continue;
    h.mp++; a.mp++;
    h.pts += r.ptsHome; a.pts += r.ptsAway;
    h.gw += r.home; h.gl += r.away; a.gw += r.away; a.gl += r.home;
    if (r.scoredHome != null) { h.ps += r.scoredHome; h.pa += r.scoredAway; a.ps += r.scoredAway; a.pa += r.scoredHome; }
    if (r.ptsHome > r.ptsAway) { h.mw++; a.ml++; } else if (r.ptsAway > r.ptsHome) { a.mw++; h.ml++; } else { h.mt++; a.mt++; }
    h2h.set(`${hId}|${aId}`, (h2h.get(`${hId}|${aId}`) || 0) + r.ptsHome);
    h2h.set(`${aId}|${hId}`, (h2h.get(`${aId}|${hId}`) || 0) + r.ptsAway);
  }
  const list = [...rows.values()].map(r => ({ ...r, gd: r.gw - r.gl }));
  // Head-to-head among everyone tied on points (points earned vs the others in the tie).
  const byPts = new Map();
  for (const r of list) (byPts.get(r.pts) || byPts.set(r.pts, []).get(r.pts)).push(r);
  for (const group of byPts.values()) {
    for (const r of group) r.h2h = group.reduce((t, o) => t + (o === r ? 0 : (h2h.get(`${r.teamId}|${o.teamId}`) || 0)), 0);
  }
  list.sort((x, y) => y.pts - x.pts || y.h2h - x.h2h || y.gw - x.gw || y.ps - x.ps || x.name.localeCompare(y.name));
  list.forEach((r, i) => { r.rank = i + 1; });
  return list;
}

// ── Lineup rule checks (PVTC) ─────────────────────────────────────────────
// Warnings, not hard blocks — the captain may know something we don't (a
// medical sub, a missing gender on file). Returned to managers on save.
export function lineupWarnings(league, slots) {
  const info = (e) => league.roster.find(p => p.email === e) || { name: e };
  const warn = [];
  const S = normSlots(slots);
  const everyone = new Set(S.flatMap(s => s.players).filter(Boolean));
  if (everyone.size && everyone.size < 4) warn.push(`Only ${everyone.size} players — PVTC requires at least 4 each week.`);
  if (everyone.size > 8) warn.push(`${everyone.size} players — PVTC allows at most 8 per night.`);
  for (const r of [1, 2]) {
    const rs = S.filter(s => s.round === r);
    const count = {}, pairs = {};
    for (const s of rs) {
      const [a, b] = s.players;
      for (const e of [a, b]) if (e) count[e] = (count[e] || 0) + 1;
      if (a && b) {
        const k = [a, b].sort().join('|');
        if (pairs[k]) warn.push(`Round ${r}: ${info(a).name} & ${info(b).name} are paired twice (G${pairs[k]} and G${s.no}) — same partner only once per round.`);
        else pairs[k] = s.no;
      }
      const g = [a, b].map(e => e ? (info(e).gender || '').toUpperCase()[0] : '');
      if (a && b && g[0] && g[1]) {
        const ok = s.type === 'MD' ? g[0] === 'M' && g[1] === 'M' : s.type === 'WD' ? g[0] === 'F' && g[1] === 'F' : g[0] !== g[1];
        if (!ok) warn.push(`G${s.no} is ${TYPE_LABEL[s.type].toLowerCase()} doubles — check ${info(a).name} & ${info(b).name}.`);
      }
    }
    for (const [e, n] of Object.entries(count)) if (n > 3) warn.push(`Round ${r}: ${info(e).name} is in ${n} games — max 3 per round.`);
  }
  return warn;
}

// ── Playoff eligibility (PVTC) ────────────────────────────────────────────
// A player must play in at least 1/3 of the regular-season matches. "Played"
// = in our lineup for a match that has been scored or has started.
export function eligibility(league, now = Date.now()) {
  const regular = allMatches(league).filter(({ week, match }) => ['regular', 'roundrobin'].includes(week.type) && isOurs(league, match));
  const needed = Math.ceil(regular.length / 3);
  const played = {};
  for (const { week, match } of regular) {
    const happened = (match.slots || []).some(slotScored) || matchResult(league, match) || laMs(matchDate(week, match), match.time) < now;
    if (!happened) continue;
    for (const e of new Set((match.slots || []).flatMap(s => s.players || []).filter(Boolean))) played[e] = (played[e] || 0) + 1;
  }
  return { total: regular.length, needed, played };
}

// ── Our stats ────────────────────────────────────────────────────────────
export function computeStats(league) {
  const nameOf = (e) => league.roster.find(p => p.email === e)?.name || e;
  const players = new Map();
  const P = (e) => {
    if (!players.has(e)) players.set(e, { email: e, name: nameOf(e), nights: new Set(), gp: 0, w: 0, l: 0, pf: 0, pa: 0, partners: {} });
    return players.get(e);
  };
  const vsTeams = new Map();   // opponent teamId → {name, mp, mw, ml, gw, gl, pf, pa}
  const oppPlayers = new Map(); // `${teamId}|${name}` → {name, teamName, gp, w, l}  (their W/L vs us)
  const team = { mp: 0, mw: 0, ml: 0, mt: 0, pts: 0, gw: 0, gl: 0, pf: 0, pa: 0 };
  const games = [];

  for (const { week, match } of allMatches(league)) {
    const side = ourSide(league, match);
    if (!side) continue;
    const opp = opponentOf(league, match);
    const oppName = teamName(league, opp);
    const scored = (match.slots || []).filter(slotScored);
    const r = matchResult(league, match);
    if (r) {
      const us = side === 'home' ? r.home : r.away, them = side === 'home' ? r.away : r.home;
      const pu = side === 'home' ? r.ptsHome : r.ptsAway, pt = side === 'home' ? r.ptsAway : r.ptsHome;
      team.mp++; team.gw += us; team.gl += them; team.pts += pu;
      if (pu > pt) team.mw++; else if (pt > pu) team.ml++; else team.mt++;
      const key = opp?.teamId || oppName;
      if (!vsTeams.has(key)) vsTeams.set(key, { name: oppName, mp: 0, mw: 0, ml: 0, gw: 0, gl: 0, pf: 0, pa: 0 });
      const v = vsTeams.get(key);
      v.mp++; v.gw += us; v.gl += them; if (pu > pt) v.mw++; else if (pt > pu) v.ml++;
      for (const s of scored) { v.pf += s.us; v.pa += s.them; }
    }
    for (const s of scored) {
      const won = s.us > s.them;
      team.pf += s.us; team.pa += s.them;
      const [a, b] = s.players;
      for (const [me, pt] of [[a, b], [b, a]]) {
        if (!me) continue;
        const p = P(me);
        p.nights.add(match.id); p.gp++; won ? p.w++ : p.l++; p.pf += s.us; p.pa += s.them;
        if (pt) { const q = p.partners[pt] || (p.partners[pt] = { email: pt, name: nameOf(pt), gp: 0, w: 0 }); q.gp++; if (won) q.w++; }
      }
      for (const on of s.opp) {
        if (!on) continue;
        const k = `${opp?.teamId || oppName}|${on.toLowerCase()}`;
        const o = oppPlayers.get(k) || { name: on, teamName: oppName, gp: 0, w: 0, l: 0 };
        o.gp++; won ? o.l++ : o.w++;
        oppPlayers.set(k, o);
      }
      games.push({ matchId: match.id, week: week.label, date: week.date, opponent: oppName, no: s.no, players: s.players.map(nameOf), opp: s.opp, us: s.us, them: s.them, won });
    }
  }

  const playerList = [...players.values()].map(p => ({
    email: p.email, name: p.name, nights: p.nights.size, gp: p.gp, w: p.w, l: p.l,
    pct: p.gp ? p.w / p.gp : 0, pf: p.pf, pa: p.pa, diff: p.pf - p.pa,
    avgDiff: p.gp ? (p.pf - p.pa) / p.gp : 0,
    partners: Object.values(p.partners).sort((x, y) => y.gp - x.gp || y.w - x.w),
  })).sort((x, y) => y.pct - x.pct || y.gp - x.gp || y.diff - x.diff);

  const pairs = new Map();
  for (const g of games) {
    const k = [...g.players].sort().join(' & ');
    if (!g.players[0] || !g.players[1]) continue;
    const r = pairs.get(k) || { pair: k, gp: 0, w: 0, diff: 0 };
    r.gp++; if (g.won) r.w++; r.diff += g.us - g.them;
    pairs.set(k, r);
  }

  return {
    team,
    players: playerList,
    pairs: [...pairs.values()].sort((x, y) => (y.w / y.gp) - (x.w / x.gp) || y.gp - x.gp),
    vsTeams: [...vsTeams.values()],
    oppPlayers: [...oppPlayers.values()].sort((x, y) => y.gp - x.gp || y.w - x.w),
    games,
  };
}

// ── Change detection for notifications ─────────────────────────────────────
/** Map email → sorted list of "G3 w/ Name" lines — what a player cares about. */
export function gamesByPlayer(league, slots) {
  const nameOf = (e) => league.roster.find(p => p.email === e)?.name || e;
  const map = {};
  for (const s of slots || []) {
    const [a, b] = s.players || [];
    for (const [me, pt] of [[a, b], [b, a]]) {
      if (!me) continue;
      (map[me] ||= []).push({ no: s.no, round: roundOf(s.no), type: typeOf(s.no), partner: pt ? nameOf(pt) : '' });
    }
  }
  return map;
}
/** Emails whose games changed between two lineups (added, dropped, or moved). */
export function lineupChangedFor(league, prevSlots, nextSlots) {
  const a = gamesByPlayer(league, prevSlots), b = gamesByPlayer(league, nextSlots);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of keys) if (JSON.stringify(a[k] || []) !== JSON.stringify(b[k] || [])) out.push(k);
  return out;
}

/** Human list of what changed on a match edit. */
export function describeMatchChange(league, before, after, wkBefore, wkAfter) {
  const lines = [];
  const db = matchDate(wkBefore, before), da = matchDate(wkAfter, after);
  if (db !== da) lines.push(`Date: ${dateLine(db)} → ${dateLine(da)}`);
  if ((before.time || '') !== (after.time || '')) lines.push(`Time: ${before.time || '—'} → ${after.time || '—'}`);
  if ((before.courts || '') !== (after.courts || '')) lines.push(`Courts: ${before.courts || '—'} → ${after.courts || '—'}`);
  const hb = teamName(league, before.home), ha = teamName(league, after.home);
  const ab = teamName(league, before.away), aa = teamName(league, after.away);
  if (hb !== ha || ab !== aa) lines.push(`Matchup: ${hb} vs ${ab} → ${ha} vs ${aa}`);
  if ((before.note || '') !== (after.note || '')) lines.push(`Note: ${after.note || '(cleared)'}`);
  return lines;
}
