// =============================================================
// GET /api/public-seasons
//
// Returns seasons with open registration for the public
// registration page. No auth required.
//
// Response: { seasons: [{ id, name, label, divisions, registration }] }
// Only returns seasons where registration !== 'closed'.
// Strips Stripe IDs and internal fields.
// =============================================================

import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const store = getStore('seasons');
    const { blobs } = await store.list();
    const seasons = [];

    for (const blob of blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      try {
        const season = JSON.parse(raw);
        // Never surface test/demo seasons on the public registration page.
        if (season.isTest === true) continue;
        // Only return seasons with open or paused registration
        if (season.registration === 'closed' || season.status === 'archived') continue;

        seasons.push({
          id: season.id,
          name: season.name,
          label: season.label,
          status: season.status,
          registration: season.registration,
          startDate: season.startDate,
          weeks: season.weeks || 8,
          matchTime: season.matchTime || '7:00–9:00 PM',
          roundsPerMatch: season.roundsPerMatch || 2,
          gamesPerRound: season.gamesPerRound || 6,
          maxRosterSize: season.maxRosterSize || 10,
          divisions: season.divisions.map((d) => ({
            id: d.id,
            name: d.name,
            capacity: d.capacity,
            teamPrice: d.teamPrice,
            agentPrice: d.agentPrice,
          })),
        });
      } catch {}
    }

    return new Response(JSON.stringify({ seasons }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    console.error('public-seasons error:', err);
    return new Response(JSON.stringify({ seasons: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
