// netlify/functions/admin-finalize-season.js
//
// Admin-only. Snapshots final player stats for a completed circuit into
// the persistent player-history store. Run once at end of season.
//
// POST /.netlify/functions/admin-finalize-season?circuit=I
//   body: { seasonLabel: "Season 1", year: 2026 }   (optional metadata)
//
// Writes / merges: player-history/<playerId>.json
//   { playerId, seasons: [ { circuit, seasonLabel, year, teamId, teamName, stats } ] }
//
// Safe to re-run — won't duplicate if the same circuit already exists in history.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  const url    = new URL(req.url);
  const circuit = (url.searchParams.get('circuit') || 'I').trim();

  let meta = {};
  try { meta = await req.json(); } catch {}
  const seasonLabel = meta.seasonLabel || `Circuit ${circuit}`;
  const year        = meta.year || new Date().getFullYear();

  try {
    const psStore   = getStore('player-stats');
    const histStore = getStore('player-history');

    const psData = await psStore.get(`player-stats/${circuit}.json`, { type: 'json' }).catch(() => null);
    if (!psData?.players) {
      return json({ error: 'No player stats found for this circuit. Run rebuild-standings first.' }, 400);
    }

    let snapshotted = 0;
    let skipped = 0;

    for (const [playerId, stats] of Object.entries(psData.players)) {
      // Read existing history
      const existing = await histStore.get(`${playerId}.json`, { type: 'json' }).catch(() => null);
      const seasons  = existing?.seasons || [];

      // Don't duplicate
      if (seasons.some(s => s.circuit === circuit)) { skipped++; continue; }

      seasons.push({
        circuit,
        seasonLabel,
        year,
        teamId:   stats.teamId   || null,
        teamName: stats.teamName || null,
        stats: {
          gamesPlayed:   stats.gamesPlayed,
          gamesWon:      stats.gamesWon,
          gamesLost:     stats.gamesLost,
          matchesPlayed: stats.matchesPlayed,
          byType:        stats.byType,
          // partners not snapshotted (IDs only useful within a season)
        },
      });

      await histStore.setJSON(`${playerId}.json`, {
        playerId,
        name:    stats.name,
        seasons: seasons.sort((a, b) => a.circuit.localeCompare(b.circuit)),
      });
      snapshotted++;
    }

    return json({ ok: true, circuit, seasonLabel, snapshotted, skipped });
  } catch (err) {
    console.error('admin-finalize-season error:', err);
    return json({ error: 'Failed to finalize season', detail: err.message }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/.netlify/functions/admin-finalize-season' };
