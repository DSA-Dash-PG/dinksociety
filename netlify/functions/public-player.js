// netlify/functions/public-player.js
//
// PUBLIC endpoint — no auth.
// Returns a player's current-season stats plus their cross-season history.
//
// GET /.netlify/functions/public-player?id=<playerId>[&circuit=I][&games=1][&seasons=1]
//   → {
//       player: { playerId, name, gender, teamId, teamName,
//                 gamesPlayed, gamesWon, gamesLost, byType, matchesPlayed,
//                 partners: { partnerId: { played, won } } },
//       partnerNames: { partnerId: { name, teamName } },
//       history: [ { circuit, season, teamId, teamName, stats: {...} } ],
//       games:   [ ... ]                       (&games=1 — the viewed season's game log)
//       seasons: [ <season package>, ... ]     (&seasons=1 — EVERY season she played,
//                                               fully computed for the profile's
//                                               Seasons card: headline strip, DSR
//                                               trend with league average, rating /
//                                               scoring / matchup boxes, match log
//                                               with per-game DSR, partners)
//       career:  { ... }                       (&seasons=1 — totals, per-season rows,
//                                               splits, highlights, all-time partners)
//     }
//
// Cross-season history is written by admin-finalize-season.js (one entry per season).
// Key: player-history/<playerId>.json
//
// IDENTITY: a person gets a new roster id every time she joins a team, so this
// endpoint asks lib/league-identity.js for every id belonging to the same human
// (same email, plus any admin links) and merges their stats and history. That is
// what lets a returning player — or one who leaves to captain her own team —
// keep her whole record instead of starting from zero. Nothing is rewritten;
// the merge happens here, on read.
//
// The season packages do ALL the arithmetic the profile page used to do in the
// browser from the whole player-stats blob (ranks, league averages, snapshot
// DSRs per game). The page only renders. Career numbers add up W–L, points and
// clutch; DSR is a RATING, so a career shows each season's final + peak and
// never a sum.

import { getStore } from '@netlify/blobs';
import { normalizeScore } from './lib/score-helpers.js';
import { identityIndex, mergeStatRows } from './lib/league-identity.js';
import { seasonName } from './lib/circuit.js';

// Slot type by slot key (matches lib/standings.js)
const SLOT_TYPE = {
  r1g1: 'womens', r1g2: 'mens', r1g3: 'mixed', r1g4: 'mixed', r1g5: 'mixed', r1g6: 'mixed',
  r2g1: 'womens', r2g2: 'mens', r2g3: 'mixed', r2g4: 'mixed', r2g5: 'mixed', r2g6: 'mixed',
};
const SLOT_KEYS = Object.keys(SLOT_TYPE);
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const seasonOrder = code => { const i = ROMAN.indexOf(String(code || '').toUpperCase()); return i >= 0 ? i : 99; };

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const playerId = url.searchParams.get('id') || '';
  const circuit  = (url.searchParams.get('circuit') || 'I').trim();
  const wantGames = url.searchParams.get('games') === '1';
  const wantSeasons = url.searchParams.get('seasons') === '1';

  if (!playerId) {
    return json({ error: 'player id required' }, 400);
  }

  try {
    // ── Who is this, really? Every roster id for the same person ──
    const identity = await identityIndex();
    const ids = identity.idsFor(playerId);

    // ── Current-season stats, merged across her ids ───────
    const psStore = getStore('player-stats');
    const psData  = await psStore.get(`player-stats/${circuit}.json`, { type: 'json' }).catch(() => null);
    const rows = ids
      .map(id => (psData?.players?.[id] ? { ...psData.players[id], __id: id } : null))
      .filter(Boolean);
    const player = mergeStatRows(rows, playerId);
    if (player) delete player.__id;

    // ── Resolve partner names from same player-stats blob ─
    const partnerNames = {};
    if (player?.partners && psData?.players) {
      for (const partnerId of Object.keys(player.partners)) {
        const p = psData.players[partnerId];
        if (p) partnerNames[partnerId] = { name: p.name, teamName: p.teamName || null };
      }
    }

    // ── Cross-season history, concatenated across her ids ──
    // Each id carries its own player-history blob; a season she played on two
    // teams legitimately yields two rows, so only exact (season, team) repeats
    // are dropped.
    const histStore = getStore('player-history');
    const histDocs = await Promise.all(
      ids.map(id => histStore.get(`${id}.json`, { type: 'json' }).catch(() => null))
    );
    const seen = new Set();
    const history = histDocs
      .flatMap(doc => doc?.seasons || [])
      .filter(s => {
        const k = `${s.circuit}|${s.teamId || ''}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    // History blobs are only written when an admin finalizes a season. A season
    // that was played but never finalized would otherwise vanish from her
    // record, so fill the gaps straight from that season's stats blob. There is
    // one blob per season, so this is a handful of small reads.
    const pastAwards = [];
    const allStats = await loadAllSeasonStats(circuit, psData);
    const pastRows = pastSeasonRows(ids, circuit, seen, pastAwards, allStats);
    for (const past of pastRows) history.push(past);

    // ── Career awards: POTW / Chef of the Week from every season ──
    // Each season's stats blob carries that season's awards; the client used to
    // read only the viewed season's, so a Season 1 POTW vanished on the Season 2
    // view. Stamp the season so the Trophy Case can label them.
    const careerAwards = [];
    for (const a of (player?.awards || [])) careerAwards.push({ ...a, season: a.season || circuit });
    for (const a of pastAwards) careerAwards.push(a);

    // ── Profile photo, across her ids ──
    // Photos are keyed by the roster id they were uploaded under. A new season
    // means a new roster entry with no photo stamp, so look through every id.
    let photoUrl = null;
    try {
      const ph = getStore('player-photos');
      for (const id of ids) {
        const meta = await ph.getMetadata(`img/${id}`).catch(() => null);
        if (meta) { photoUrl = '/.netlify/functions/player-photo-serve?id=' + encodeURIComponent(id) + (meta.etag ? '&v=' + encodeURIComponent(meta.etag) : ''); break; }
      }
    } catch { photoUrl = null; }

    history.sort((a, b) => String(a.circuit || '').localeCompare(String(b.circuit || '')));

    // ── Per-game log (opt-in via &games=1) ────────────────
    let games;
    if (wantGames && player?.teamId && !wantSeasons) {
      games = (await buildGameLog(circuit, playerId, player.teamId, psData, ids).catch(err => {
        console.error('public-player game log error:', err);
        return undefined;
      }))?.games;
    }

    // ── Season packages + career (opt-in via &seasons=1) ─────
    let seasons, career;
    if (wantSeasons) {
      const codes = Object.keys(allStats)
        .filter(code => ids.some(id => allStats[code]?.players?.[id]))
        .sort((a, b) => seasonOrder(b) - seasonOrder(a)); // newest first
      seasons = (await Promise.all(codes.map(code =>
        buildSeasonPackage(code, playerId, ids, allStats[code], history).catch(err => {
          console.error(`public-player season package ${code} failed:`, err);
          return null;
        })
      ))).filter(Boolean);
      career = buildCareer(seasons, careerAwards, identity);
      if (games === undefined && wantGames) {
        const cur = seasons.find(s => s.circuit === circuit);
        if (cur) games = cur.games;
      }
    }

    return json({
      player,
      partnerNames,
      history,
      careerAwards,
      photoUrl,
      // Transparency for the UI: how many roster entries this profile covers.
      identity: { ids, merged: ids.length > 1 },
      ...(games ? { games } : {}),
      ...(seasons ? { seasons, career } : {}),
    });
  } catch (err) {
    console.error('public-player error:', err);
    return json({ error: 'Player data unavailable' }, 500);
  }
};

/**
 * Every season's player-stats blob, keyed by circuit code (TEST excluded).
 * The viewed season's blob is passed in so it isn't read twice.
 */
async function loadAllSeasonStats(currentCircuit, currentData) {
  const out = {};
  if (currentData?.players) out[currentCircuit] = currentData;
  try {
    const store = getStore('player-stats');
    const { blobs } = await store.list().catch(() => ({ blobs: [] }));
    await Promise.all(blobs.map(async b => {
      const code = String(b.key).replace(/^player-stats\//, '').replace(/\.json$/, '');
      if (!code || code === currentCircuit || code.toUpperCase() === 'TEST') return;
      const data = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (data?.players) out[code] = data;
    }));
  } catch (err) {
    console.error('loadAllSeasonStats failed:', err.message);
  }
  return out;
}

/**
 * Build a chronological per-game log for one player.
 * Scans only this player's team's finalized matches (~8 per season), reading
 * the lineup pair + score record for each — mirrors lib/standings.js reads.
 * Names resolve from the player-stats blob (every rostered player is seeded).
 *
 * `ids` is every roster id belonging to this person, so a lineup that names an
 * older entry of hers still counts as her game.
 *
 * Also returns the team's next unfinalized match (`upcoming`) and whether the
 * team won/lost its championship match (`champ`), read off the same schedule.
 */
async function buildGameLog(circuit, playerId, teamId, psData, ids = [playerId]) {
  const mine = new Set(ids.length ? ids : [playerId]);
  const scheduleStore = getStore('schedule');
  const lineupStore   = getStore('lineups');
  const scoresStore   = getStore('scores');

  const { blobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` });
  const weekFiles = (await Promise.all(
    blobs.map(b => scheduleStore.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(wf => wf?.matches);

  const nameOf = pid => psData?.players?.[pid]?.name || null;

  const games = [];
  let upcoming = null;
  let champ = null;
  for (const wf of weekFiles) {
    for (const match of wf.matches) {
      const isHome = match.teamA?.id === teamId;
      const isAway = match.teamB?.id === teamId;
      if (!isHome && !isAway) continue;
      const oppTeam = isHome ? match.teamB : match.teamA;

      if (!match.finalizedAt) {
        const cand = { week: wf.week ?? null, phase: match.phase || null, date: match.scheduledAt || null,
          opponentTeamId: oppTeam?.id || null, opponentTeamName: oppTeam?.name || null };
        if (!upcoming || (cand.week ?? 99) < (upcoming.week ?? 99)) upcoming = cand;
        continue;
      }

      // Bracket placement. Week 8 has TWO championship-flagged matches (gold
      // AND bronze both play win-by-2), so "won a championship match" is not
      // "champion" — read the bracket slot the schedule generator stamped
      // (lib/bracket.js), mirroring computeBracketFinish on the home page:
      // gold → 1st/2nd, bronze → 3rd/4th, consolation → 5th/6th.
      const placed = bracketPlace(match, isHome);
      if (placed && (!champ || placed.place < champ.place)) {
        champ = { ...placed, week: wf.week ?? null, opponentTeamName: oppTeam?.name || null };
      }

      const [myLineup, oppLineup, score] = await Promise.all([
        lineupStore.get(`lineup/${match.id}/${teamId}.json`, { type: 'json' }).catch(() => null),
        lineupStore.get(`lineup/${match.id}/${oppTeam.id}.json`, { type: 'json' }).catch(() => null),
        scoresStore.get(`score/${match.id}.json`, { type: 'json' }).catch(() => null),
      ]);
      if (!myLineup || !oppLineup || !score?.games) continue;

      normalizeScore(score, !!match.championship);

      // Team result for the night (match points from the finalized schedule).
      const teamResult = (Number.isFinite(match.scoreA) && Number.isFinite(match.scoreB))
        ? { for: isHome ? match.scoreA : match.scoreB, against: isHome ? match.scoreB : match.scoreA }
        : null;

      for (const slot of SLOT_KEYS) {
        const picks = myLineup.games?.[slot];
        if (!picks) continue;
        const pair = [picks.p1, picks.p2].filter(Boolean);
        if (!pair.some(id => mine.has(id))) continue;

        const gs = score.games[slot];
        const homeScore = gs?.home, awayScore = gs?.away;
        if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) continue;

        const myScore  = isHome ? homeScore : awayScore;
        const oppScore = isHome ? awayScore : homeScore;
        const oppPicks = oppLineup.games?.[slot];
        const oppIds   = [oppPicks?.p1, oppPicks?.p2].filter(Boolean);
        const partnerId = pair.find(pid => !mine.has(pid)) || null;

        games.push({
          matchId: match.id,
          week: wf.week ?? null,
          phase: match.phase || null,
          championship: !!match.championship,
          date: match.scheduledAt || null,
          opponentTeamId: oppTeam.id,
          opponentTeamName: oppTeam.name,
          teamResult,
          round: slot.startsWith('r1') ? 1 : 2,
          slot,
          type: SLOT_TYPE[slot],
          partnerId,
          partnerName: partnerId ? nameOf(partnerId) : null,
          partnerTeamName: partnerId ? (psData?.players?.[partnerId]?.teamName || null) : null,
          oppIds,
          oppNames: oppIds.map(nameOf),
          oppTeams: oppIds.map(pid => psData?.players?.[pid]?.teamName || null),
          myScore,
          oppScore,
          won: myScore > oppScore ? true : myScore < oppScore ? false : null,
        });
      }
    }
  }

  // Chronological: week, then date, then round/slot order
  games.sort((a, b) => (a.week ?? 0) - (b.week ?? 0)
    || String(a.date || '').localeCompare(String(b.date || ''))
    || SLOT_KEYS.indexOf(a.slot) - SLOT_KEYS.indexOf(b.slot));
  return { games, upcoming, champ };
}

// Where a finalized bracket match leaves this team: { place, label, medal, won }.
// null for round-robin / semifinal / unfinished matches.
const PLACE_LABEL = { 1: 'Gold', 2: 'Silver', 3: 'Bronze', 4: '4th', 5: '5th', 6: '6th' };
const PLACE_MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
function bracketPlace(match, isHome) {
  const a = match.scoreA, b = match.scoreB;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  const won = (isHome ? a : b) > (isHome ? b : a);
  const slot = String(match.bracketSlot || '').toLowerCase();
  const medal = `${match.medal || ''} ${match.bracketGroup || match.gameLabel || ''}`;
  const place = String(match.placeLabel || '');
  let top = null;
  if (slot === 'gold' || /🥇|gold/i.test(medal)) top = 1;
  else if (slot === 'bronze' || /🥉|bronze/i.test(medal)) top = 3;
  else if (slot === 'consolation' || /5th/i.test(place) || /consolation/i.test(medal)) top = 5;
  if (top == null) return null;
  const p = won ? top : top + 1;
  return { place: p, label: PLACE_LABEL[p], medal: PLACE_MEDAL[p] || null, won, champion: p === 1 };
}

/**
 * Seasons this person played that have no finalized history entry yet.
 * Reads each `player-stats/<circuit>.json` (one per season) and synthesizes the
 * same row shape admin-finalize-season.js writes, marked `provisional` so the
 * UI can tell the difference if it ever wants to.
 */
function pastSeasonRows(ids, currentCircuit, seen, awardsOut = [], allStats = {}) {
  const out = [];
  for (const code of Object.keys(allStats)) {
    if (code === currentCircuit) continue;   // current season is reported separately
    const data = allStats[code];
    if (!data?.players) continue;
    for (const id of ids) {
      const p = data.players[id];
      if (!p) continue;
      // Awards are collected from every past season, finalized or not —
      // finalized history rows don't carry them.
      for (const a of (Array.isArray(p.awards) ? p.awards : [])) awardsOut.push({ ...a, season: a.season || code });
      const k = `${code}|${p.teamId || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        circuit: code,
        seasonLabel: seasonName(code),
        year: null,
        teamId: p.teamId || null,
        teamName: p.teamName || null,
        provisional: true,
        stats: {
          gamesPlayed:   p.gamesPlayed,
          gamesWon:      p.gamesWon,
          gamesLost:     p.gamesLost,
          matchesPlayed: p.matchesPlayed,
          byType:        p.byType,
          // Points + end-of-season rating, so a career roll-up on the
          // profile can show more than a W–L line.
          ps:            p.ps ?? null,
          pa:            p.pa ?? null,
          diff:          p.diff ?? null,
          composite:     p.composite ?? null,
        },
      });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// Season package — everything the profile's Seasons card shows for one
// season, computed here from that season's player-stats blob + schedule.
// ═══════════════════════════════════════════════════════════════════════

const norm = g => { const s = String(g || '').trim().toLowerCase(); return s[0] === 'f' ? 'F' : s[0] === 'm' ? 'M' : ''; };
const r1 = v => (v == null || !Number.isFinite(+v)) ? null : Math.round(+v * 10) / 10;
const pctOf = (won, played) => played ? Math.round(won / played * 100) : 0;

async function buildSeasonPackage(code, playerId, ids, psData, history) {
  const players = psData.players || {};
  const rows = ids.map(id => (players[id] ? { ...players[id], __id: id } : null)).filter(Boolean);
  const stat = mergeStatRows(rows, playerId);
  if (!stat) return null;
  const primaryId = stat.__id || rows[0].__id;
  delete stat.__id;
  const allP = Object.values(players);
  const myGender = norm(stat.gender);
  const gType = myGender === 'F' ? 'womens' : 'mens';

  // ── Ranks: league-wide by DSR, overall + within gender (qualified only) ──
  const withDsr = allP.filter(p => p.composite != null && p.dsrQualified !== false);
  let overallRank = null, genderRank = null;
  if (stat.composite != null && stat.dsrQualified !== false) {
    const better = (p) => p.composite > stat.composite;
    overallRank = withDsr.filter(better).length + 1;
    genderRank  = withDsr.filter(p => norm(p.gender) === myGender && better(p)).length + 1;
  }

  // ── League envelope for the trend chart: weekly average, rank pools, DSR range ──
  const avgByWeek = {};
  const pool = { all: 0, gender: 0, mixed: 0 };
  const range = { all: [Infinity, -Infinity], gender: [Infinity, -Infinity], mixed: [Infinity, -Infinity] };
  const perWeek = {};
  const span = (k, v) => { if (v == null) return; if (v < range[k][0]) range[k][0] = v; if (v > range[k][1]) range[k][1] = v; };
  for (const p of allP) {
    const sameGender = norm(p.gender) === myGender;
    for (const h of (p.dsrHistory || [])) {
      if (h.dsr != null) (avgByWeek[h.week] ||= []).push(h.dsr);
      const w = (perWeek[h.week] ||= { all: 0, gender: 0, mixed: 0 });
      if (h.rankProv != null) w.all = Math.max(w.all, h.rankProv);
      if (sameGender && h.gRankProv != null) w.gender = Math.max(w.gender, h.gRankProv);
      if (h.xRankProv != null) w.mixed = Math.max(w.mixed, h.xRankProv);
      span('all', h.dsr); span('gender', sameGender ? h.gDsr : null); span('mixed', h.xDsr);
    }
  }
  const leagueAvg = {};
  for (const [wk, vals] of Object.entries(avgByWeek)) leagueAvg[wk] = r1(vals.reduce((s, v) => s + v, 0) / vals.length);
  for (const w of Object.values(perWeek)) for (const k of Object.keys(pool)) pool[k] = Math.max(pool[k], w[k]);
  for (const k of Object.keys(range)) if (!isFinite(range[k][0])) range[k] = null;

  // ── Partner / opponent strength (game-weighted mean of their composites) ──
  const weighted = (map) => {
    let wSum = 0, gSum = 0, n = 0;
    for (const [pid, v] of Object.entries(map || {})) {
      const played = v && typeof v === 'object' ? (v.played || 0) : (v || 0);
      const comp = players[pid]?.composite;
      if (played > 0 && comp != null) { wSum += comp * played; gSum += played; n++; }
    }
    return { avg: gSum > 0 ? r1(wSum / gSum) : null, n };
  };
  const partnerStrength = weighted(stat.partners);
  const opponentStrength = weighted(stat.opponents);

  // ── Game log (with snapshot DSRs), upcoming match, championship result ──
  const log = stat.teamId
    ? await buildGameLog(code, primaryId, stat.teamId, psData, ids).catch(err => { console.error('season game log failed', code, err); return { games: [], upcoming: null, champ: null }; })
    : { games: [], upcoming: null, champ: null };
  // Snapshot DSR: each player's season-to-date rating as of that game's week,
  // for that game's discipline (Mixed games compare Mixed DSR, gender-line
  // games compare Men's/Women's DSR), falling back to the overall snapshot.
  const dsrAt = (pid, week, type) => {
    const hist = players[pid]?.dsrHistory;
    if (Array.isArray(hist) && hist.length && week != null) {
      let best = null;
      for (const h of hist) if (h.week <= week && (!best || h.week > best.week)) best = h;
      if (best) {
        const v = type === 'mixed' ? (best.xDsr ?? best.dsr)
                : (type === 'mens' || type === 'womens') ? (best.gDsr ?? best.dsr)
                : best.dsr;
        if (v != null) return { v, snap: true };
      }
    }
    const cur = players[pid]?.composite;
    return cur != null ? { v: cur, snap: false } : null;
  };
  const myHistId = ids.find(id => Array.isArray(players[id]?.dsrHistory) && players[id].dsrHistory.length) || primaryId;
  for (const g of log.games) {
    const mine = dsrAt(myHistId, g.week, g.type);
    g.myDsr = mine ? r1(mine.v) : null;
    const oppRes = (g.oppIds || []).map(pid => dsrAt(pid, g.week, g.type)).filter(Boolean);
    g.oppDsr = oppRes.length ? r1(oppRes.reduce((s, r) => s + r.v, 0) / oppRes.length) : null;
    g.isSnap = !!(mine?.snap && oppRes.length && oppRes.every(r => r.snap));
  }

  // ── Weekly records: the chart's x-axis (W–L · ±diff per week, DNP weeks kept) ──
  const dsrHistory = (stat.dsrHistory || []).slice().sort((a, b) => a.week - b.week);
  const wkRec = {};
  const fromRecords = new Set();
  for (const r of (stat.weeklyGameRecords || [])) { wkRec[r.week] = { w: r.w || 0, l: r.l || 0, date: r.date || null, diff: 0, opp: null, matchId: null }; fromRecords.add(r.week); }
  for (const g of log.games) {
    const w = (wkRec[g.week] ||= { w: 0, l: 0, date: g.date, diff: 0, opp: null, matchId: null });
    w.diff += (g.myScore - g.oppScore);
    w.opp = g.opponentTeamName; w.matchId = g.matchId; if (!w.date) w.date = g.date;
    // Weeks the stats blob didn't record (older blobs, post-season) count from the log.
    if (!fromRecords.has(g.week)) { if (g.won === true) w.w++; else if (g.won === false) w.l++; }
  }
  const weekNums = new Set([...dsrHistory.map(h => h.week), ...Object.keys(wkRec).map(Number)]);
  const weeks = [...weekNums].filter(Number.isFinite).sort((a, b) => a - b).map(wk => {
    const r = wkRec[wk]; const h = dsrHistory.find(x => x.week === wk) || null;
    const played = !!r && (r.w + r.l) > 0;
    return { week: wk, played, w: r?.w || 0, l: r?.l || 0, diff: r?.diff || 0, date: r?.date || null,
      opponentTeamName: r?.opp || null, matchId: r?.matchId || null,
      dsr: h?.dsr ?? null, rank: h?.rank ?? null, rankProv: h?.rankProv ?? null };
  });

  // ── Streaks (game-level, chronological) ──
  let cur = 0, curKind = null, best = 0, run = 0;
  for (const g of log.games) {
    if (g.won == null) continue;
    if (g.won) { run++; if (run > best) best = run; } else run = 0;
    if (curKind === null) { curKind = g.won ? 'W' : 'L'; cur = 1; }
    else if ((curKind === 'W') === g.won) cur++;
    else { curKind = g.won ? 'W' : 'L'; cur = 1; }
  }
  const streak = curKind ? { kind: curKind, n: cur } : null;

  // ── Peak DSR + week ──
  let peak = null;
  for (const h of dsrHistory) if (h.dsr != null && (!peak || h.dsr > peak.dsr)) peak = { dsr: h.dsr, week: h.week };
  if (!peak && stat.composite != null) peak = { dsr: r1(stat.composite), week: null };

  // ── Key opponent: the team faced most (regular season), with the record vs them ──
  const vsTeam = {};
  for (const g of log.games) {
    const t = (vsTeam[g.opponentTeamId] ||= { teamId: g.opponentTeamId, teamName: g.opponentTeamName, w: 0, l: 0 });
    if (g.won === true) t.w++; else if (g.won === false) t.l++;
  }
  const keyOpponent = Object.values(vsTeam).sort((a, b) => (b.w + b.l) - (a.w + a.l))[0] || null;

  // ── Finish: regular-season rank in the division + championship result ──
  let finish = null;
  try {
    const st = await getStore({ name: 'standings', consistency: 'strong' }).get(`standings/${code}.json`, { type: 'json' }).catch(() => null);
    if (st?.divisions && stat.teamId) {
      for (const [div, d] of Object.entries(st.divisions)) {
        const t = (d.teams || []).find(x => x.teamId === stat.teamId);
        if (t) { finish = { division: div, rank: t.rank ?? null, teams: (d.teams || []).length, wins: t.wins ?? null, losses: t.losses ?? null }; break; }
      }
    }
  } catch {}
  if (log.champ) finish = { ...(finish || {}), place: log.champ.place, label: log.champ.label, medal: log.champ.medal, champion: log.champ.place === 1, finalist: log.champ.place <= 2, medalist: log.champ.place <= 3 };

  // ── Partners for this season (named) ──
  const partners = Object.entries(stat.partners || {}).map(([pid, v]) => {
    const isObj = v && typeof v === 'object';
    const p = players[pid];
    return { playerId: pid, name: p?.name || null, teamName: p?.teamName || null, gender: p?.gender || null,
      played: isObj ? (v.played || 0) : (v || 0), won: isObj ? (v.won || 0) : 0, dsr: r1(p?.composite) };
  }).filter(p => p.played > 0 && p.name).sort((a, b) => b.played - a.played || b.won - a.won);

  const bt = stat.byType || {};
  const split = (t) => bt[t] ? { played: bt[t].played || 0, won: bt[t].won || 0, ps: bt[t].ps ?? null, pa: bt[t].pa ?? null, diff: bt[t].diff ?? null, clutchW: bt[t].clutchW || 0, clutchG: bt[t].clutchG || 0 } : null;

  const hist = history.find(h => h.circuit === code && (!stat.teamId || h.teamId === stat.teamId)) || history.find(h => h.circuit === code) || null;

  return {
    circuit: code,
    seasonLabel: seasonName(code),
    year: hist?.year || null,
    finalized: !!(hist && !hist.provisional),
    weeksPlayed: psData.weeksPlayed ?? null,
    needGames: psData.needGames ?? null,
    teamId: stat.teamId || null,
    teamName: stat.teamName || null,
    teams: stat.teams || null,
    name: stat.name || null,
    gender: myGender || null,
    // Headline + boxes
    record: { w: stat.gamesWon || 0, l: stat.gamesLost || 0, played: stat.gamesPlayed || 0, matches: stat.matchesPlayed || 0, pct: pctOf(stat.gamesWon || 0, stat.gamesPlayed || 0) },
    points: { ps: stat.ps ?? null, pa: stat.pa ?? null, diff: stat.diff ?? null,
      wonPct: (stat.ps + stat.pa) > 0 ? Math.round(stat.ps / (stat.ps + stat.pa) * 1000) / 10 : null,
      avgMargin: stat.gamesPlayed ? r1((stat.diff || 0) / stat.gamesPlayed) : null,
      avgPointsPct: stat.avgPointsPct ?? null },
    rating: {
      dsr: r1(stat.composite), qualified: stat.dsrQualified !== false, overallRank, genderRank,
      gender: { dsr: r1(stat.dsrGender), rank: stat.dsrGenderRank ?? null, qualified: stat.dsrGenderQualified !== false, games: bt[gType]?.played || 0 },
      mixed:  { dsr: r1(stat.dsrMixed),  rank: stat.dsrMixedRank ?? null,  qualified: stat.dsrMixedQualified !== false,  games: bt.mixed?.played || 0 },
      peak, consistency: stat.consistency != null ? Math.round(stat.consistency * 100) : null,
      breakdown: stat.dsrBreakdown || null,
      bestRank: dsrHistory.reduce((m, h) => (h.rank != null && (m == null || h.rank < m)) ? h.rank : m, null),
    },
    clutch: { w: stat.clutchW || 0, g: stat.clutchG || 0 },
    splits: { gender: split(gType), mixed: split('mixed'), genderType: gType },
    strength: { partner: partnerStrength.avg, partners: partnerStrength.n, opponent: opponentStrength.avg, opponents: opponentStrength.n },
    streak, bestStreak: best, keyOpponent, finish,
    awards: (stat.awards || []).map(a => ({ ...a, season: a.season || code })),
    // Trend + log
    dsrHistory, weeks, leagueAvg, pool, range,
    totalWeeks: Math.max(psData.weeksPlayed || 0, ...weeks.map(w => w.week), log.upcoming?.week || 0, 7),
    upcoming: log.upcoming,
    games: log.games,
    partners,
    weeklyGameRecords: stat.weeklyGameRecords || [],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Career — rolls the season packages up. Counting stats add; DSR never does.
// ═══════════════════════════════════════════════════════════════════════

function buildCareer(seasons, careerAwards, identity) {
  const played = seasons.filter(s => s.record.played > 0);
  const sum = f => played.reduce((n, s) => n + (Number(f(s)) || 0), 0);
  const w = sum(s => s.record.w), l = sum(s => s.record.l), gp = sum(s => s.record.played), mp = sum(s => s.record.matches);
  const hasPts = played.some(s => s.points.ps != null);
  const ps = hasPts ? sum(s => s.points.ps) : null, pa = hasPts ? sum(s => s.points.pa) : null;
  const diff = hasPts ? ps - pa : null;
  const cW = sum(s => s.clutch.w), cG = sum(s => s.clutch.g);

  // Peak DSR across every week of every season.
  let peak = null;
  for (const s of played) if (s.rating.peak && (!peak || s.rating.peak.dsr > peak.dsr)) peak = { ...s.rating.peak, circuit: s.circuit, seasonLabel: s.seasonLabel };

  // Splits (gender line + mixed) across seasons.
  const splitSum = (k) => played.reduce((a, s) => { const b = s.splits[k]; if (b) { a.played += b.played; a.won += b.won; a.clutchW += b.clutchW; a.clutchG += b.clutchG; } return a; }, { played: 0, won: 0, clutchW: 0, clutchG: 0 });

  // Highlights.
  let bestWeek = null;
  for (const s of played) for (const wk of s.weeks) {
    if (!wk.played) continue;
    const score = wk.w - wk.l + wk.diff / 100;
    if (!bestWeek || score > bestWeek._score) bestWeek = { _score: score, circuit: s.circuit, seasonLabel: s.seasonLabel, week: wk.week, w: wk.w, l: wk.l, diff: wk.diff, opponentTeamName: wk.opponentTeamName };
  }
  if (bestWeek) delete bestWeek._score;
  let longestStreak = null;
  for (const s of played) if (s.bestStreak && (!longestStreak || s.bestStreak > longestStreak.n)) longestStreak = { n: s.bestStreak, circuit: s.circuit, seasonLabel: s.seasonLabel };
  // Biggest stage: a championship > playoff > rivalry night, by the deepest run.
  let biggestStage = null;
  const stageRank = { championship: 3, playoff: 2, rivalry: 1 };
  for (const s of played) for (const g of s.games) {
    const ph = g.championship ? 'championship' : g.phase;
    const rk = stageRank[ph] || 0;
    if (rk && (!biggestStage || rk > biggestStage._rk)) biggestStage = { _rk: rk, phase: ph, circuit: s.circuit, seasonLabel: s.seasonLabel, week: g.week, opponentTeamName: g.opponentTeamName, champion: s.finish?.champion ?? null, place: s.finish?.place ?? null, label: s.finish?.label ?? null };
  }
  if (biggestStage) delete biggestStage._rk;
  const finals = played.filter(s => s.finish?.finalist).length;
  const titles = played.filter(s => s.finish?.champion === true).length;
  const medals = { gold: titles, silver: played.filter(s => s.finish?.place === 2).length, bronze: played.filter(s => s.finish?.place === 3).length };
  // Every award on a stats row is a Player of the Week (lib/standings.js attachAwards).
  const potw = (careerAwards || []).length;

  // All-time partners, merged across seasons through the identity layer so the
  // same human (new roster id each season) is one row.
  const byPerson = {};
  for (const s of played) for (const p of s.partners) {
    const ids = identity.idsFor(p.playerId);
    const key = ids.slice().sort().join('|') || p.playerId;
    const row = (byPerson[key] ||= { playerId: p.playerId, name: p.name, teamName: p.teamName, played: 0, won: 0, seasons: [] });
    row.played += p.played; row.won += p.won;
    if (!row.seasons.includes(s.circuit)) row.seasons.push(s.circuit);
    // Name/team follow the newest season (seasons arrive newest first).
    if (seasonOrder(s.circuit) >= Math.max(...row.seasons.map(seasonOrder))) { row.name = p.name; row.teamName = p.teamName; row.playerId = p.playerId; }
  }
  const partners = Object.values(byPerson).sort((a, b) => b.played - a.played || b.won - a.won);

  return {
    seasons: played.length,
    record: { w, l, played: gp, matches: mp, pct: pctOf(w, gp) },
    points: { ps, pa, diff, wonPct: (ps != null && pa != null && ps + pa > 0) ? Math.round(ps / (ps + pa) * 1000) / 10 : null },
    clutch: { w: cW, g: cG },
    peak,
    hardware: { finals, titles, medals, potw, awards: (careerAwards || []).length },
    splits: { gender: splitSum('gender'), mixed: splitSum('mixed') },
    highlights: { bestWeek, longestStreak, peak, biggestStage },
    rows: played.map(s => ({
      circuit: s.circuit, seasonLabel: s.seasonLabel, teamId: s.teamId, teamName: s.teamName, finalized: s.finalized,
      w: s.record.w, l: s.record.l, played: s.record.played, matches: s.record.matches, pct: s.record.pct,
      ps: s.points.ps, pa: s.points.pa, diff: s.points.diff,
      dsr: s.rating.dsr, peak: s.rating.peak?.dsr ?? null, overallRank: s.rating.overallRank, genderRank: s.rating.genderRank,
      clutchW: s.clutch.w, clutchG: s.clutch.g, finish: s.finish, awards: s.awards.length,
    })),
    partners,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

export const config = { path: '/.netlify/functions/public-player' };
