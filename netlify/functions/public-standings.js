// netlify/functions/public-standings.js
//
// PUBLIC endpoint — no auth. Returns standings for the public standings
// and leaderboard pages. Reads from 'standings' blob store.
//
// GET /.netlify/functions/public-standings?season=circuit-i
//   → { divisions: { "3-0-mixed": { teams: [...] }, "3-5-mixed": { teams: [...] } }, lastUpdated }
//
// Also works as the backing endpoint for the leaderboard page when
// public-leaderboard reads a different key format.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const seasonId = url.searchParams.get('season') || 'circuit-i';
  const division = url.searchParams.get('division') || '';

  try {
    const store = getStore('standings');
    const { blobs } = await store.list();
    const divisions = {};
    let lastUpdated = null;

    for (const blob of blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        // Filter by season
        if (data.seasonId && data.seasonId !== seasonId) continue;
        // Filter by division if requested
        if (division && data.division !== division) continue;

        const divId = data.division;
        const teams = (data.standings || []).map((t, i) => ({
          rank: i + 1,
          teamId: t.teamId,
          teamName: t.teamName,
          wins: t.w,
          losses: t.l,
          ties: t.t || 0,
          matchPointsFor: t.pts,
          matchPointsAgainst: 0, // not tracked separately in seed
          totalGamesWon: t.gw,
          totalGamesLost: t.gl,
          pointDiff: t.pd,
          sweeps: 0, // would need match-level data to compute
          // Society Circuit points — projected from placement
          societyCircuitPoints: [100, 75, 50, 30, 15, 15][i] || 10,
          weeklyBonusPoints: 0,
          placementBonus: [100, 75, 50, 30, 15, 15][i] || 10,
        }));

        divisions[divId] = {
          divisionLabel: data.divisionLabel || divId,
          teams,
        };

        if (data.updatedAt && (!lastUpdated || data.updatedAt > lastUpdated)) {
          lastUpdated = data.updatedAt;
        }
      } catch {}
    }

    if (!Object.keys(divisions).length) {
      return new Response(JSON.stringify({
        empty: true,
        message: 'No standings yet. Come back once matches are underway.',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      });
    }

    return new Response(JSON.stringify({ divisions, lastUpdated }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    console.error('public-standings error:', err);
    return new Response(JSON.stringify({
      empty: true,
      message: 'Standings unavailable.',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/public-standings' };
