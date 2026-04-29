// netlify/functions/public-schedule.js
//
// PUBLIC endpoint — no auth. Returns the match schedule for a season,
// grouped by week. Reads from the 'schedule' blob store first (generated
// by admin-generate-schedule), then falls back to the 'matches' store
// (populated by seed-demo-data).
//
// GET /.netlify/functions/public-schedule?season=circuit-i[&division=3-0-mixed]
//   → { weeks: [ { week, matches: [...] } ] }

import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const seasonId = url.searchParams.get('season') || 'circuit-i';
  const divisionFilter = url.searchParams.get('division') || '';

  try {
    // Try the schedule store first (admin-generated round-robin)
    const schedStore = getStore('schedule');
    const { blobs: schedBlobs } = await schedStore.list();
    
    if (schedBlobs.length > 0) {
      const weekMap = {};
      for (const b of schedBlobs) {
        const data = await schedStore.get(b.key, { type: 'json' }).catch(() => null);
        if (!data?.matches) continue;
        if (divisionFilter && data.division !== divisionFilter) continue;

        const w = data.week || 1;
        if (!weekMap[w]) weekMap[w] = { week: w, division: data.division, matches: [] };
        for (const m of data.matches) {
          weekMap[w].matches.push({
            id: m.id,
            teamA: m.teamA?.name || 'TBD',
            teamB: m.teamB?.name || 'TBD',
            court: m.court || null,
            scheduledAt: m.scheduledAt || null,
            scoreA: m.scoreA ?? null,
            scoreB: m.scoreB ?? null,
            status: m.playedAt ? 'final' : 'scheduled',
            division: data.division,
          });
        }
      }

      const weeks = Object.values(weekMap).sort((a, b) => a.week - b.week);
      if (weeks.length > 0) {
        return json({ weeks });
      }
    }

    // Fallback: read individual match records from 'matches' store (seed-demo-data format)
    const matchStore = getStore('matches');
    const { blobs: matchBlobs } = await matchStore.list();
    const weekMap = {};

    for (const b of matchBlobs) {
      const raw = await matchStore.get(b.key);
      if (!raw) continue;
      try {
        const m = JSON.parse(raw);
        if (m.seasonId && m.seasonId !== seasonId) continue;
        if (divisionFilter && m.division !== divisionFilter) continue;

        const w = m.week || 1;
        if (!weekMap[w]) weekMap[w] = { week: w, matches: [] };
        weekMap[w].matches.push({
          id: m.id,
          teamA: m.homeTeamName || 'TBD',
          teamB: m.awayTeamName || 'TBD',
          court: m.court || null,
          date: m.date || null,
          scheduledAt: m.scheduledAt || null,
          status: m.status || 'scheduled',
          division: m.division,
          divisionLabel: m.divisionLabel || '',
          // Include scores for finalized matches
          homeRoundPts: m.homeRoundPts ?? null,
          awayRoundPts: m.awayRoundPts ?? null,
          homeGameWins: m.homeGameWins ?? null,
          awayGameWins: m.awayGameWins ?? null,
        });
      } catch {}
    }

    const weeks = Object.values(weekMap).sort((a, b) => a.week - b.week);

    if (!weeks.length) {
      return json({
        empty: true,
        message: 'Schedule not yet published. Check back closer to game time.',
      });
    }

    return json({ weeks });
  } catch (err) {
    console.error('public-schedule error:', err);
    return json({
      empty: true,
      message: 'Schedule unavailable.',
    });
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

export const config = { path: '/.netlify/functions/public-schedule' };
