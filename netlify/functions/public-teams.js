// netlify/functions/public-teams.js
//
// PUBLIC endpoint — no auth. Returns teams grouped by division for
// the public teams page. Reads from the 'teams' blob store.
//
// GET /.netlify/functions/public-teams?season=circuit-i
//   → { teams: [ { id, name, emoji, division, captain, roster: [{ name, gender, dupr }] } ] }
//
// Player emails are stripped for privacy.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const seasonId = url.searchParams.get('season') || 'circuit-i';
  const division = url.searchParams.get('division') || '';

  try {
    const store = getStore('teams');
    const { blobs } = await store.list();
    const teams = [];

    for (const blob of blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      try {
        const team = JSON.parse(raw);
        // Filter by season if present
        if (team.seasonId && team.seasonId !== seasonId) continue;
        // Filter by division if requested
        if (division && team.division !== division) continue;

        teams.push({
          id: team.id,
          name: team.name,
          emoji: team.emoji || '🏓',
          division: team.division,
          captain: team.captain || (team.roster?.[0]?.name) || '',
          roster: (team.roster || []).map(p => ({
            name: p.name,
            gender: p.gender || '',
            dupr: p.dupr || null,
            isCaptain: p.role === 'captain' || p.isCaptain || false,
          })),
        });
      } catch {}
    }

    // Sort by division then name
    teams.sort((a, b) => a.division.localeCompare(b.division) || a.name.localeCompare(b.name));

    return new Response(JSON.stringify({ teams }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    console.error('public-teams error:', err);
    return new Response(JSON.stringify({ teams: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/public-teams' };
