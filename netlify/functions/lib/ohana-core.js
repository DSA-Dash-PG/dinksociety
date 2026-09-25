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

// ── Lineup slots ─────────────────────────────────────────────────────────
function num(v) { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; }
export function normSlots(slots, n = GAMES_PER_MATCH) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = (slots || []).find(x => Number(x?.no) === i + 1) || (slots || [])[i] || {};
    const players = [0, 1].map(j => String(s.players?.[j] || '').trim().toLowerCase());
    const opp = [0, 1].map(j => String(s.opp?.[j] || '').trim().slice(0, 60));
    out.push({ no: i + 1, players, opp, us: num(s.us), them: num(s.them) });
  }
  return out;
}
export function slotScored(s) { return s && s.us != null && s.them != null && s.us !== s.them; }

/** Final games won {home, away} or null. Our matches roll up from game scores. */
export function matchResult(league, m) {
  const side = ourSide(league, m);
  if (side && (m.slots || []).some(slotScored)) {
    let us = 0, them = 0;
    for (const s of m.slots) if (slotScored(s)) (s.us > s.them ? us++ : them++);
    return side === 'home' ? { home: us, away: them } : { home: them, away: us };
  }
  const r = m.result;
  if (r && Number.isFinite(+r.home) && Number.isFinite(+r.away) && (+r.home + +r.away) > 0) return { home: +r.home, away: +r.away };
  return null;
}

// ── Standings ────────────────────────────────────────────────────────────
// Ranked by games won, then match wins, then game differential. (PVTC's own
// tiebreak isn't on the schedule sheet — adjust here if they publish one.)
export function computeStandings(league) {
  const rows = new Map(league.teams.map(tm => [tm.id, { teamId: tm.id, name: tm.name, mp: 0, mw: 0, ml: 0, mt: 0, gw: 0, gl: 0 }]));
  for (const { week, match } of allMatches(league)) {
    if (!['regular', 'roundrobin'].includes(week.type) || match.counts === false) continue;
    const r = matchResult(league, match);
    const h = rows.get(match.home?.teamId), a = rows.get(match.away?.teamId);
    if (!r || !h || !a) continue;
    h.mp++; a.mp++;
    h.gw += r.home; h.gl += r.away; a.gw += r.away; a.gl += r.home;
    if (r.home > r.away) { h.mw++; a.ml++; } else if (r.away > r.home) { a.mw++; h.ml++; } else { h.mt++; a.mt++; }
  }
  const list = [...rows.values()].map(r => ({ ...r, gd: r.gw - r.gl, pct: (r.gw + r.gl) ? r.gw / (r.gw + r.gl) : 0 }));
  list.sort((x, y) => y.gw - x.gw || y.mw - x.mw || y.gd - x.gd || x.name.localeCompare(y.name));
  list.forEach((r, i) => { r.rank = i + 1; });
  return list;
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
  const team = { mp: 0, mw: 0, ml: 0, mt: 0, gw: 0, gl: 0, pf: 0, pa: 0 };
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
      team.mp++; team.gw += us; team.gl += them;
      if (us > them) team.mw++; else if (them > us) team.ml++; else team.mt++;
      const key = opp?.teamId || oppName;
      if (!vsTeams.has(key)) vsTeams.set(key, { name: oppName, mp: 0, mw: 0, ml: 0, gw: 0, gl: 0, pf: 0, pa: 0 });
      const v = vsTeams.get(key);
      v.mp++; v.gw += us; v.gl += them; if (us > them) v.mw++; else if (them > us) v.ml++;
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
      (map[me] ||= []).push({ no: s.no, partner: pt ? nameOf(pt) : '' });
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
