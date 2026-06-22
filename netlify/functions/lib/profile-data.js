// netlify/functions/lib/profile-data.js
//
// Shared builders for the UNIFIED player profile (League + Ladder). One human can
// appear in both products; the durable link between them is the normalized email
// they were rostered / signed up with.
//
//   League side  → roster entry id (= player-stats key) → DSR (composite), W-L
//   Ladder side  → ladder player id → DR + the ported scoring stats
//
// These helpers resolve an email <-> id in either product and assemble each
// product's stats so both public-profile.js (combined card) and
// public-ladder-profile.js (ladder popup) read from one source of truth.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';
import { findPlayerByEmail } from './player-auth.js';
import { listEvents, getSignups, getEvent } from './ladder.js';
import { listPlay, toSession, playersFromPlay } from './ladder-play.js';
import { calcStats, calcDinkRating, calcBonusPts, calcMvpCount, calcXP, xpTier } from './ladder-scoring.js';
import { getXpConfig, getXpGrants, grantTotals } from './xp-config.js';
import { getMergeMap, applyMerges, resolve as resolveMerge } from './player-merge.js';
import { getDirectory, applyDirectory } from './player-directory.js';

const nm = p => (p ? p.name : null);

// ─────────────────────────── LADDER ───────────────────────────

// Email for a ladder player — master directory wins, else the email they signed up
// with on any event (first match).
export async function ladderEmailById(id) {
  const dir = await getDirectory();
  if (dir[id] && dir[id].email) return normalizeEmail(dir[id].email);
  // Fallback: scan signups. Parallelize the per-event reads (independent gets).
  const events = await listEvents();
  const sus = await Promise.all(events.map(ev => getSignups(ev.id).catch(() => ({}))));
  for (const su of sus) {
    const hit = [...(su.roster || []), ...(su.waitlist || [])].find(p => p.playerId === id && p.email);
    if (hit) return normalizeEmail(hit.email);
  }
  return null;
}

// Ladder player id for an email — checks the master directory, then signups.
export async function ladderIdByEmail(rawEmail) {
  const norm = normalizeEmail(rawEmail);
  if (!norm) return null;
  const dir = await getDirectory();
  for (const [pid, info] of Object.entries(dir)) { if (info.email && normalizeEmail(info.email) === norm) return pid; }
  const events = await listEvents();
  const sus = await Promise.all(events.map(ev => getSignups(ev.id).catch(() => ({}))));
  for (const su of sus) {
    const hit = [...(su.roster || []), ...(su.waitlist || [])].find(p => p.email && normalizeEmail(p.email) === norm && p.playerId);
    if (hit) return hit.playerId;
  }
  return null;
}

// Walk play sessions chronologically and pull this player's per-round detail.
function walk(plays, id) {
  const perLadder = []; const movement = [];
  const sorted = [...plays].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  for (const play of sorted) {
    const rounds = []; const courts = []; let w = 0, l = 0;
    (play.rounds || []).forEach((rd, ri) => {
      (rd.courts || []).forEach(c => {
        const t1 = (c.team1 || []).filter(Boolean), t2 = (c.team2 || []).filter(Boolean);
        const inA = t1.some(p => p.id === id), inB = t2.some(p => p.id === id);
        if (!inA && !inB) return;
        if (!c.score || c.score.t1 == null || c.score.t2 == null || !c.score.winner) return;
        const mine = inA ? t1 : t2, opp = inA ? t2 : t1;
        const pf = inA ? c.score.t1 : c.score.t2, pa = inA ? c.score.t2 : c.score.t1;
        const won = (inA && c.score.winner === 'A') || (inB && c.score.winner === 'B');
        rounds.push({ r: ri + 1, court: c.court, partner: nm(mine.find(p => p.id !== id)), opp: opp.map(nm).filter(Boolean), pf, pa, won });
        courts.push(c.court); won ? w++ : l++;
      });
    });
    if (!rounds.length) continue;
    perLadder.push({ eventId: play.eventId, date: play.date, rounds, w, l, firstCourt: courts[0], lastCourt: courts[courts.length - 1] });
    rounds.forEach((r, i) => movement.push({ court: r.court, won: r.won, newLadder: i === 0, margin: r.pf - r.pa }));
  }
  return { perLadder, movement };
}

// Full ladder profile (the Pickleladder player card). Returns { found, email, player }.
export async function buildLadderProfile(id) {
  const _mm = await getMergeMap();
  id = resolveMerge(_mm, id);
  const plays = applyDirectory(applyMerges(await listPlay(), _mm), await getDirectory());
  const sessions = plays.map(toSession);
  const players = playersFromPlay(plays);
  const stats = calcStats(sessions, players);
  const me = stats.find(s => s.id === id);
  if (!me) return { found: false, email: await ladderEmailById(id) };

  const dr = calcDinkRating(stats, sessions, players);
  const bonus = calcBonusPts(sessions, players)[id] || {};
  const mvp = calcMvpCount(sessions, players)[id] || 0;
  const _xpCfg = await getXpConfig();
  const myXp = ((calcXP(sessions, players, dr, _xpCfg.amounts).xp[id]) || 0) + (grantTotals(await getXpGrants())[id] || 0);
  const gp = me.w + me.l;

  const ranked = stats.filter(s => s.w + s.l > 0)
    .sort((a, b) => (b.w - a.w) || ((b.pf - b.pa) - (a.pf - a.pa)) || ((dr[b.id] ?? -1) - (dr[a.id] ?? -1)));
  const rank = ranked.findIndex(s => s.id === id) + 1;

  const { perLadder, movement } = walk(plays, id);
  const resByEvent = {}; (bonus.ladderResults || []).forEach(r => { if (r.sessId) resByEvent[r.sessId] = r; });
  const playById = {}; for (const pp of plays) playById[pp.eventId] = pp;
  const evCache = {};
  for (const pl of perLadder) {
    if (!(pl.eventId in evCache)) evCache[pl.eventId] = await getEvent(pl.eventId).catch(() => null);
    const ev = evCache[pl.eventId];
    pl.name = ev?.name || 'Ladder'; pl.type = ev?.type || 'mixed';
    const rr = resByEvent[pl.eventId];
    pl.pts = rr ? rr.pts : pl.rounds.reduce((a, r) => a + r.pf, 0);
    pl.placeRank = rr ? rr.rank : null;
    pl.bonus = rr ? rr.bonus : 0;
    pl.courtDelta = pl.lastCourt - pl.firstCourt;
    // Per-ladder DR + XP earned that event (compute from that single play).
    const pp = playById[pl.eventId];
    if (pp) {
      const ess = [toSession(pp)], epl = playersFromPlay([pp]);
      const edr = calcDinkRating(calcStats(ess, epl), ess, epl);
      pl.dr = (edr[id] != null) ? edr[id] : null;
      pl.xp = (calcXP(ess, epl, edr, _xpCfg.amounts).xp[id]) || 0;
    } else { pl.dr = null; pl.xp = 0; }
  }
  perLadder.reverse();

  return {
    found: true,
    email: await ladderEmailById(id),
    player: {
      id, name: me.name, gender: me.gender, dr: dr[id], rank,
      w: me.w, l: me.l, pf: me.pf, pa: me.pa, diff: me.pf - me.pa,
      avg: me.roundPts.length ? Math.round(me.pf / me.roundPts.length * 10) / 10 : 0,
      winPct: gp ? Math.round(100 * me.w / gp) : 0,
      streak: me.streak, maxStreak: me.maxStreak,
      seasonPts: me.pf + (bonus.bonus || 0), nights: me.attended, ladders: me.attended,
      xp: myXp, xpTier: xpTier(myXp),
      podiums: (bonus.ladderResults || []).filter(r => r.rank <= 3).length, mvp,
      peakCourt: Math.max(0, ...movement.map(m => m.court)), totalRounds: movement.length,
      last10: movement.slice(-10), movement, perLadder,
    },
  };
}

// ─────────────────────────── LEAGUE ───────────────────────────

// Email of a league roster entry by its id (first match wins), or null.
export async function leagueEmailById(leagueId) {
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
  for (const team of teams) {
    const entry = (team?.roster || []).find(p => p.id === leagueId);
    if (entry) return normalizeEmail(entry.email);
  }
  return null;
}

// League profile (DSR + record + team). Returns { found, player } or { found:false }.
export async function buildLeagueProfile(leagueId, circuit = 'I') {
  if (!leagueId) return { found: false };
  const ps = await getStore('player-stats').get(`player-stats/${circuit}.json`, { type: 'json' }).catch(() => null);
  const p = ps?.players?.[leagueId];
  if (!p) return { found: false };
  const gp = (p.gamesWon || 0) + (p.gamesLost || 0);
  return {
    found: true,
    player: {
      id: leagueId, name: p.name, gender: p.gender || null,
      teamId: p.teamId || null, teamName: p.teamName || null,
      dsr: (p.composite == null ? null : Math.round(p.composite * 100) / 100),
      w: p.gamesWon || 0, l: p.gamesLost || 0,
      winPct: gp ? Math.round(100 * (p.gamesWon || 0) / gp) : 0,
      matchesPlayed: p.matchesPlayed || 0,
      ps: p.ps || 0, pa: p.pa || 0, diff: p.diff || 0,
      byType: p.byType || null,
      awards: (p.awards || []).length,
      circuit,
    },
  };
}

// ─────────────────────────── UNIFIED ───────────────────────────

// Resolve a canonical normalized email from any of: email | ladderId | leagueId.
export async function resolveEmail({ email, ladderId, leagueId }) {
  if (email) return normalizeEmail(email);
  if (ladderId) return await ladderEmailById(ladderId);
  if (leagueId) return await leagueEmailById(leagueId);
  return null;
}

// Build the combined { identity, league, ladder } for a given entry point.
export async function buildUnifiedProfile({ email, ladderId, leagueId, circuit = 'I' } = {}) {
  const canonEmail = await resolveEmail({ email, ladderId, leagueId });

  // Resolve both product ids from whatever we have.
  let lgId = leagueId || null;
  if (!lgId && canonEmail) { const m = await findPlayerByEmail(canonEmail); lgId = m?.playerId || null; }
  let ldId = ladderId || null;
  if (!ldId && canonEmail) ldId = await ladderIdByEmail(canonEmail);

  const league = lgId ? await buildLeagueProfile(lgId, circuit) : { found: false };
  const ladder = ldId ? await buildLadderProfile(ldId) : { found: false };

  const name = (league.found && league.player.name) || (ladder.found && ladder.player.name) || null;
  if (!name) return { found: false };

  return {
    found: true,
    // NOTE: email is intentionally NOT exposed in this public payload (privacy).
    // It's used server-side to link the two products, but the client only needs
    // presence flags.
    identity: { name, hasLeague: league.found, hasLadder: ladder.found },
    league: league.found ? league.player : null,
    ladder: ladder.found ? ladder.player : null,
  };
}
