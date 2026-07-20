// netlify/functions/public-gameday.js
//
// PUBLIC endpoint — no auth. One call returns everything the live ticker,
// the homepage card and the /live venue board need for a given game night.
// It is the public, read-only counterpart to admin-gameday.js.
//
// GET /.netlify/functions/public-gameday?season=circuit-i[&division=3-0-mixed][&week=6]
//
// Week selection, when ?week is omitted: the soonest week that still has a
// non-final match scheduled within the last 6 hours (i.e. "tonight"), else
// the lowest unfinished week, else the last week of the season.
//
// ---------------------------------------------------------------------------
// WHAT IS AND ISN'T PUBLIC
// ---------------------------------------------------------------------------
// Scores  — only CONFIRMED games. captain-score.js marks a game confirmed
//           when the away captain's confirmation matches the home captain's
//           entry; normalizeScore() then syncs the canonical home/away values.
//           Anything unconfirmed or disputed has null canonical values and is
//           skipped here, exactly as public-match.js does it.
// Players — gated behind the blind-lineup reveal: visible once the match is
//           final, OR both lineups are locked AND isRevealTime() has passed.
// Points  — round points are awarded by score-helpers only when all 6 games
//           of a round are confirmed (winner 2, tie 1-1); match points are
//           r1 + r2 on a 0-4 scale. decorate() computes these from confirmed
//           games alone, so they accrue live — finalize merely persists them
//           to the schedule blob as scoreA/scoreB.
// ---------------------------------------------------------------------------

import { getStore } from '@netlify/blobs';
import { normalizeScore, decorate } from './lib/score-helpers.js';
import { etagJson } from './lib/http-cache.js';
import { isRevealTime } from './lib/lineup-helpers.js';

// Slot → discipline. Mirrors public-match.js exactly.
const SLOT_TYPE = {
  r1g1: 'WD', r1g2: 'MD', r1g3: 'MX', r1g4: 'MX', r1g5: 'MX', r1g6: 'MX',
  r2g1: 'WD', r2g2: 'MD', r2g3: 'MX', r2g4: 'MX', r2g5: 'MX', r2g6: 'MX',
};
const SLOT_KEYS = Object.keys(SLOT_TYPE);
const GAMES_TOTAL = SLOT_KEYS.length;

const RECENT_MS = 6 * 60 * 60 * 1000;   // a match still counts as "tonight" 6h after start
const FEED_MAX = 12;

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const seasonId = url.searchParams.get('season') || 'circuit-i';
  const divisionFilter = url.searchParams.get('division') || '';
  const weekParam = Number(url.searchParams.get('week')) || null;

  try {
    const circuitLetter = seasonId.replace('circuit-', '').toUpperCase();
    const schedStore = getStore('schedule');

    // ---- 1. load this circuit's schedule blobs once ----
    const { blobs } = await schedStore.list({ prefix: `schedule/${circuitLetter}/` });
    const weeks = [];
    for (const b of blobs) {
      const data = await schedStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!data?.matches) continue;
      if (data.circuit && data.circuit !== circuitLetter) continue;
      if (divisionFilter && data.division && data.division !== divisionFilter) continue;
      weeks.push({
        week: data.week || 1,
        division: data.division || null,
        phase: data.phase || null,
        phaseLabel: data.phaseLabel || null,
        matches: data.matches,
      });
    }
    if (!weeks.length) {
      return etagJson(req, emptyPayload(seasonId, 'No schedule published yet.'));
    }

    // ---- 2. pick the week ----
    const picked = weekParam
      ? weeks.filter(w => w.week === weekParam)
      : pickWeek(weeks);
    if (!picked.length) {
      return etagJson(req, emptyPayload(seasonId, 'No matches found for that week.'));
    }

    const week = picked[0].week;
    const phase = picked.find(w => w.phase)?.phase || 'regular';
    const phaseLabel = picked.find(w => w.phaseLabel)?.phaseLabel || null;
    const allMatches = picked.flatMap(w =>
      w.matches.map(m => ({ ...m, week: w.week, division: m.division || w.division })));

    // Bracket placeholders (playoff slots with no teams resolved yet) can't
    // be rendered as a live match — drop them rather than emit null teams.
    const matches = allMatches.filter(m => m.teamA?.id || m.teamB?.id || m.teamA || m.teamB);

    // ---- 3. teams (emoji + colour), scores, lineups ----
    const teamsStore = getStore('teams');
    const scoresStore = getStore({ name: 'scores', consistency: 'strong' });
    const lineupStore = getStore('lineups');

    const teamMeta = await loadTeamMeta(teamsStore, matches);

    const enriched = await Promise.all(matches.map(async (m) => {
      const homeId = m.teamA?.id || m.teamAId || null;
      const awayId = m.teamB?.id || m.teamBId || null;

      const [score, lineupA, lineupB] = await Promise.all([
        scoresStore.get(`score/${m.id}.json`, { type: 'json' }).catch(() => null),
        homeId ? lineupStore.get(`lineup/${m.id}/${homeId}.json`, { type: 'json' }).catch(() => null) : null,
        awayId ? lineupStore.get(`lineup/${m.id}/${awayId}.json`, { type: 'json' }).catch(() => null) : null,
      ]);

      if (score) normalizeScore(score, !!m.championship);
      const dec = score ? decorate(score, !!m.championship) : null;

      const final = !!(m.finalizedAt || score?.finalizedAt);
      const lineupsVisible = final
        || (!!lineupA?.lockedAt && !!lineupB?.lockedAt && isRevealTime(m.scheduledAt));

      const lgA = lineupsVisible ? (lineupA?.games || {}) : {};
      const lgB = lineupsVisible ? (lineupB?.games || {}) : {};
      const statusBySlot = Object.fromEntries(
        (dec?.computed?.gameStatuses || []).map(g => [g.slot, g.status]));

      // ---- confirmed games only ----
      const games = [];
      let gamesHome = 0, gamesAway = 0, pointsHome = 0, pointsAway = 0;
      let nextSlot = null;

      for (const slot of SLOT_KEYS) {
        const confirmed = statusBySlot[slot] === 'confirmed';
        const g = score?.games?.[slot];
        const h = g?.home, a = g?.away;

        if (!confirmed || !Number.isInteger(h) || !Number.isInteger(a)) {
          if (!nextSlot) nextSlot = slot;         // first unconfirmed = likely on court
          continue;
        }
        if (h > a) gamesHome++; else if (a > h) gamesAway++;
        pointsHome += h; pointsAway += a;

        games.push({
          slot,
          round: slot.startsWith('r1') ? 1 : 2,
          gameNum: Number(slot.slice(-1)),
          type: SLOT_TYPE[slot],
          home: h,
          away: a,
          homeWin: h > a,
          homePlayers: pairNames(lgA[slot]),
          awayPlayers: pairNames(lgB[slot]),
        });
      }

      const r1 = dec?.computed?.round1 || null;
      const r2 = dec?.computed?.round2 || null;
      const gamesConfirmed = games.length;

      // "on court now" — the first unconfirmed slot, if we may show names
      const current = (!final && nextSlot && lineupsVisible && (lgA[nextSlot] || lgB[nextSlot]))
        ? {
            slot: nextSlot,
            round: nextSlot.startsWith('r1') ? 1 : 2,
            gameNum: Number(nextSlot.slice(-1)),
            type: SLOT_TYPE[nextSlot],
            homePlayers: pairNames(lgA[nextSlot]),
            awayPlayers: pairNames(lgB[nextSlot]),
          }
        : null;

      // "live" is time-boxed. A match that was played but never formally
      // finalized must not sit on the ticker as LIVE for days — once it falls
      // out of the recent window we present whatever was confirmed as done.
      const started = m.scheduledAt ? Date.parse(m.scheduledAt) <= Date.now() : false;
      const inWindow = isTonight(m.scheduledAt);
      const status = final ? 'final'
        : (inWindow && (gamesConfirmed > 0 || (started && lineupsVisible))) ? 'live'
        : gamesConfirmed > 0 ? 'final'
        : 'awaiting';

      return {
        id: m.id,
        division: m.division || null,
        court: m.court || null,
        courtA: m.courtA ?? null,
        courtB: m.courtB ?? null,
        courtSet: m.courtSet ?? null,
        venue: m.venue || null,
        scheduledAt: m.scheduledAt || null,
        startTime: m.startTime || null,
        championship: !!m.championship,
        status,
        lineupsVisible,
        home: teamSide(homeId, m.teamA, m.emojiA, m.seedLabelA, teamMeta),
        away: teamSide(awayId, m.teamB, m.emojiB, m.seedLabelB, teamMeta),
        games,
        current,
        gamesHome,
        gamesAway,
        gamesConfirmed,
        gamesTotal: GAMES_TOTAL,
        round1: r1,
        round2: r2,
        pointsHome,
        pointsAway,
        // final match points only once persisted; clients derive live MP from rounds
        mpHome: m.scoreA ?? null,
        mpAway: m.scoreB ?? null,
      };
    }));

    // ---- 4. results feed (newest confirmed games first) ----
    const feed = buildFeed(enriched).slice(0, FEED_MAX);

    // ---- 5. season standings for the charts ----
    const standings = await loadStandings(circuitLetter, divisionFilter, teamMeta);

    // Bracket blobs often carry no seedLabel (it's synthesized at render time
    // by public-schedule). Rivalry pairings ARE the seeding, so fall back to
    // each team's standings rank rather than showing a blank badge.
    const rankById = Object.fromEntries(standings.map(t => [t.teamId, t.rank]));
    for (const m of enriched) {
      for (const side of [m.home, m.away]) {
        if (!side.seedLabel && side.id && rankById[side.id]) {
          side.seedLabel = '#' + rankById[side.id] + ' Seed';
        }
      }
    }

    // gameNight drives whether the ticker shows at all. Tie it to the clock,
    // not to match status, so nothing can strand it on-screen.
    const anyToday = enriched.some(m => isTonight(m.scheduledAt));

    return etagJson(req, {
      season: seasonId,
      week,
      phase,
      phaseLabel: phaseLabel || (phase === 'rivalry' ? 'Rivalry Week' : null),
      gameNight: anyToday,
      venue: enriched.find(m => m.venue)?.venue || null,
      matches: enriched,
      feed,
      standings,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('public-gameday error:', err);
    return json({ error: 'game night data unavailable' }, 500);
  }
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Prefer the week that is happening now, then the first unfinished one.
function pickWeek(weeks) {
  const now = Date.now();
  const byWeek = new Map();
  for (const w of weeks) {
    if (!byWeek.has(w.week)) byWeek.set(w.week, []);
    byWeek.get(w.week).push(w);
  }

  let tonight = null, unfinished = null;
  for (const [num, group] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const ms = group.flatMap(g => g.matches);
    const live = ms.some(m => !m.finalizedAt && m.scheduledAt &&
      Date.parse(m.scheduledAt) <= now && now - Date.parse(m.scheduledAt) < RECENT_MS);
    if (live && tonight === null) tonight = group;
    if (!unfinished && ms.some(m => !m.finalizedAt)) unfinished = group;
  }
  if (tonight) return tonight;
  if (unfinished) return unfinished;
  const last = Math.max(...byWeek.keys());
  return byWeek.get(last);
}

function isTonight(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const now = Date.now();
  // within the next 12h or the last 6h
  return t - now < 12 * 60 * 60 * 1000 && now - t < RECENT_MS;
}

function pairNames(slot) {
  return [slot?.p1Name, slot?.p2Name].filter(Boolean);
}

function teamSide(id, team, emoji, seedLabel, meta) {
  const name = (typeof team === 'string' ? team : team?.name) || 'TBD';
  const m = (id && meta[id]) || {};
  return {
    id: id || null,
    name,
    emoji: emoji || m.emoji || '',
    color: m.color || null,
    seedLabel: seedLabel || null,
  };
}

async function loadTeamMeta(teamsStore, matches) {
  const ids = new Set();
  for (const m of matches) {
    const a = m.teamA?.id || m.teamAId, b = m.teamB?.id || m.teamBId;
    if (a) ids.add(a);
    if (b) ids.add(b);
  }
  const meta = {};
  await Promise.all([...ids].map(async (id) => {
    const t = await teamsStore.get(`team/${id}.json`, { type: 'json' }).catch(() => null)
           || await teamsStore.get(`${id}.json`, { type: 'json' }).catch(() => null);
    if (t) meta[id] = { emoji: t.emoji || '', color: t.color || null, name: t.name };
  }));
  return meta;
}

// Newest confirmed games across all courts, players first — the players are
// the headline on the venue board, the teams are the sub-line.
function buildFeed(matches) {
  const rows = [];
  for (const m of matches) {
    for (const g of m.games) {
      const homeWon = g.homeWin;
      const winner = homeWon ? m.home : m.away;
      const loser = homeWon ? m.away : m.home;
      const hi = Math.max(g.home, g.away), lo = Math.min(g.home, g.away);
      rows.push({
        id: `${m.id}:${g.slot}`,
        matchId: m.id,
        slot: g.slot,
        round: g.round,
        gameNum: g.gameNum,
        type: g.type,
        courtLabel: courtForGame(m, g),
        winner: winner.name,
        loser: loser.name,
        winnerPlayers: homeWon ? g.homePlayers : g.awayPlayers,
        loserPlayers: homeWon ? g.awayPlayers : g.homePlayers,
        score: `${hi}–${lo}`,
        tag: hi - lo <= 2 ? 'Nailbiter' : null,
        at: null,
      });
    }
  }
  // lib/courts.js convention: odd games on court A, even on court B
  return rows.sort((a, b) =>
    (b.round - a.round) || (b.gameNum - a.gameNum) || a.matchId.localeCompare(b.matchId));
}

function courtForGame(m, g) {
  const c = (g.gameNum % 2 === 1) ? m.courtA : m.courtB;
  return c ? `Ct ${c}` : (m.court || '');
}

async function loadStandings(circuitLetter, divisionFilter, teamMeta) {
  try {
    const store = getStore('standings');
    const blob = await store.get(`standings/${circuitLetter}.json`, { type: 'json' }).catch(() => null);
    if (!blob) return [];

    // Canonical shape (see public-standings.js): { divisions: { <divId>: { teams: [...] } } }
    let rows = [];
    if (blob.divisions) {
      const entries = Object.entries(blob.divisions)
        .filter(([divId]) => !divisionFilter || divId === divisionFilter);
      rows = entries.flatMap(([, d]) => d.teams || []);
    } else if (Array.isArray(blob)) {
      rows = blob;                                   // legacy blobs
    } else {
      rows = Object.values(blob).find(Array.isArray) || [];
    }

    return rows
      .slice()
      .sort((a, b) => (b.matchPointsFor ?? b.pts ?? 0) - (a.matchPointsFor ?? a.pts ?? 0))
      .map((t, i) => {
        const id = t.teamId || t.id;
        const meta = (id && teamMeta[id]) || {};
        return {
          teamId: id || null,
          name: t.teamName || t.name || meta.name || '',
          emoji: t.teamEmoji || meta.emoji || '',
          color: meta.color || null,
          rank: i + 1,
          mp: t.matchPointsFor ?? t.pts ?? 0,
          mpAgainst: t.matchPointsAgainst ?? 0,
          pointsFor: t.pointsScored ?? null,
          pointsAgainst: t.pointsAgainst ?? null,
        };
      });
  } catch {
    return [];   // charts are decoration; never fail the whole payload for them
  }
}

function emptyPayload(seasonId, message) {
  return {
    season: seasonId,
    week: null,
    phase: 'regular',
    phaseLabel: null,
    gameNight: false,
    venue: null,
    matches: [],
    feed: [],
    standings: [],
    message,
    updatedAt: new Date().toISOString(),
  };
}

// Errors only — success responses go through etagJson (ETag + short CDN cache).
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const config = { path: '/.netlify/functions/public-gameday' };
