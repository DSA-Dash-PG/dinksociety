// netlify/functions/public-player.js
//
// PUBLIC endpoint — no auth.
// Returns a player's current-season stats plus their cross-season history.
//
// GET /.netlify/functions/public-player?id=<playerId>[&circuit=I]
//   → {
//       player: { playerId, name, gender, teamId, teamName,
//                 gamesPlayed, gamesWon, gamesLost, byType, matchesPlayed,
//                 partners: { partnerId: { played, won } } },
//       partnerNames: { partnerId: { name, teamName } },
//       history: [ { circuit, season, teamId, teamName, stats: {...} } ]
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

import { getStore } from '@netlify/blobs';
import { normalizeScore } from './lib/score-helpers.js';
import { identityIdsFor, mergeStatRows } from './lib/league-identity.js';
import { seasonName } from './lib/circuit.js';

// Slot type by slot key (matches lib/standings.js)
const SLOT_TYPE = {
  r1g1: 'womens', r1g2: 'mens', r1g3: 'mixed', r1g4: 'mixed', r1g5: 'mixed', r1g6: 'mixed',
  r2g1: 'womens', r2g2: 'mens', r2g3: 'mixed', r2g4: 'mixed', r2g5: 'mixed', r2g6: 'mixed',
};
const SLOT_KEYS = Object.keys(SLOT_TYPE);

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const playerId = url.searchParams.get('id') || '';
  const circuit  = (url.searchParams.get('circuit') || 'I').trim();
  const wantGames = url.searchParams.get('games') === '1';

  if (!playerId) {
    return json({ error: 'player id required' }, 400);
  }

  try {
    // ── Who is this, really? Every roster id for the same person ──
    const ids = await identityIdsFor(playerId);

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
    for (const past of await pastSeasonRows(ids, circuit, seen)) history.push(past);

    history.sort((a, b) => String(a.circuit || '').localeCompare(String(b.circuit || '')));

    // ── Per-game log (opt-in via &games=1) ────────────────
    let games;
    if (wantGames && player?.teamId) {
      games = await buildGameLog(circuit, playerId, player.teamId, psData, ids).catch(err => {
        console.error('public-player game log error:', err);
        return undefined;
      });
    }

    return json({
      player,
      partnerNames,
      history,
      // Transparency for the UI: how many roster entries this profile covers.
      identity: { ids, merged: ids.length > 1 },
      ...(games ? { games } : {}),
    });
  } catch (err) {
    console.error('public-player error:', err);
    return json({ error: 'Player data unavailable' }, 500);
  }
};

/**
 * Build a chronological per-game log for one player.
 * Scans only this player's team's finalized matches (~8 per season), reading
 * the lineup pair + score record for each — mirrors lib/standings.js reads.
 * Names resolve from the player-stats blob (every rostered player is seeded).
 *
 * `ids` is every roster id belonging to this person, so a lineup that names an
 * older entry of hers still counts as her game.
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
  for (const wf of weekFiles) {
    for (const match of wf.matches) {
      if (!match.finalizedAt) continue;
      const isHome = match.teamA?.id === teamId;
      const isAway = match.teamB?.id === teamId;
      if (!isHome && !isAway) continue;

      const oppTeam = isHome ? match.teamB : match.teamA;
      const [myLineup, oppLineup, score] = await Promise.all([
        lineupStore.get(`lineup/${match.id}/${teamId}.json`, { type: 'json' }).catch(() => null),
        lineupStore.get(`lineup/${match.id}/${oppTeam.id}.json`, { type: 'json' }).catch(() => null),
        scoresStore.get(`score/${match.id}.json`, { type: 'json' }).catch(() => null),
      ]);
      if (!myLineup || !oppLineup || !score?.games) continue;

      normalizeScore(score, !!match.championship);

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
          date: match.scheduledAt || null,
          opponentTeamId: oppTeam.id,
          opponentTeamName: oppTeam.name,
          round: slot.startsWith('r1') ? 1 : 2,
          slot,
          type: SLOT_TYPE[slot],
          partnerId,
          partnerName: partnerId ? nameOf(partnerId) : null,
          oppIds,
          oppNames: oppIds.map(nameOf),
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
  return games;
}

/**
 * Seasons this person played that have no finalized history entry yet.
 * Reads each `player-stats/<circuit>.json` (one per season) and synthesizes the
 * same row shape admin-finalize-season.js writes, marked `provisional` so the
 * UI can tell the difference if it ever wants to.
 */
async function pastSeasonRows(ids, currentCircuit, seen) {
  try {
    const store = getStore('player-stats');
    const { blobs } = await store.list().catch(() => ({ blobs: [] }));
    const out = [];
    for (const b of blobs) {
      const code = String(b.key).replace(/^player-stats\//, '').replace(/\.json$/, '');
      if (!code || code === currentCircuit) continue;   // current season is reported separately
      if (code.toUpperCase() === 'TEST') continue;      // QA season never shows on a profile
      const data = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (!data?.players) continue;
      for (const id of ids) {
        const p = data.players[id];
        if (!p) continue;
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
          },
        });
      }
    }
    return out;
  } catch (err) {
    console.error('pastSeasonRows failed:', err.message);
    return [];
  }
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
