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

import { getStore } from '@netlify/blobs';
import { normalizeScore } from './lib/score-helpers.js';

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
    // ── Current-season stats ──────────────────────────────
    const psStore = getStore('player-stats');
    const psData  = await psStore.get(`player-stats/${circuit}.json`, { type: 'json' }).catch(() => null);
    const player  = psData?.players?.[playerId] || null;

    // ── Resolve partner names from same player-stats blob ─
    const partnerNames = {};
    if (player?.partners && psData?.players) {
      for (const partnerId of Object.keys(player.partners)) {
        const p = psData.players[partnerId];
        if (p) partnerNames[partnerId] = { name: p.name, teamName: p.teamName || null };
      }
    }

    // ── Cross-season history ──────────────────────────────
    const histStore = getStore('player-history');
    const history   = await histStore.get(`${playerId}.json`, { type: 'json' }).catch(() => null);

    // ── Per-game log (opt-in via &games=1) ────────────────
    let games;
    if (wantGames && player?.teamId) {
      games = await buildGameLog(circuit, playerId, player.teamId, psData).catch(err => {
        console.error('public-player game log error:', err);
        return undefined;
      });
    }

    return json({
      player,
      partnerNames,
      history: history?.seasons || [],
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
 */
async function buildGameLog(circuit, playerId, teamId, psData) {
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
        if (!pair.includes(playerId)) continue;

        const gs = score.games[slot];
        const homeScore = gs?.home, awayScore = gs?.away;
        if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) continue;

        const myScore  = isHome ? homeScore : awayScore;
        const oppScore = isHome ? awayScore : homeScore;
        const oppPicks = oppLineup.games?.[slot];
        const oppIds   = [oppPicks?.p1, oppPicks?.p2].filter(Boolean);
        const partnerId = pair.find(pid => pid !== playerId) || null;

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
