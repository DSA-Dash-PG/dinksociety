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

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const playerId = url.searchParams.get('id') || '';
  const circuit  = (url.searchParams.get('circuit') || 'I').trim();

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

    return json({
      player,
      partnerNames,
      history: history?.seasons || [],
    });
  } catch (err) {
    console.error('public-player error:', err);
    return json({ error: 'Player data unavailable' }, 500);
  }
};

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
