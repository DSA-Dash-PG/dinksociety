// netlify/functions/admin-rebuild-standings.js
//
// Admin-only. Manually kicks off a full rebuild of the standings and
// player-stats aggregates for a given Circuit. Useful if data drifts or
// if you're retroactively editing match records.
//
// POST /.netlify/functions/admin-rebuild-standings?circuit=I

import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import { rebuildStandings } from './lib/standings.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  const url = new URL(req.url);
  const circuit = (url.searchParams.get('circuit') || 'I').trim();

  try {
    const { standings, playerStats } = await rebuildStandings(circuit);
    return json({
      ok: true,
      circuit,
      divisions: Object.keys(standings.divisions),
      teamCount: Object.values(standings.divisions).reduce((n, d) => n + d.teams.length, 0),
      playerCount: Object.keys(playerStats.players).length,
      lastUpdated: standings.lastUpdated,
    });
  } catch (err) {
    console.error('admin-rebuild-standings error:', err);
    return json({ error: 'Rebuild failed', detail: err.message }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export const config = { path: '/.netlify/functions/admin-rebuild-standings' };
