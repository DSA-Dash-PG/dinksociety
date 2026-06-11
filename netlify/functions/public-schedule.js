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
    // Derive the circuit letter for this season (circuit-i → I, circuit-test → TEST)
    const circuitLetter = seasonId.replace('circuit-', '').toUpperCase();

    // Team emoji lookup so the schedule can show team logos.
    const { byId: emojiById, byName: emojiByName } = await loadTeamEmojis(seasonId);

    // Try the schedule store first (admin-generated round-robin)
    const schedStore = getStore('schedule');
    const { blobs: schedBlobs } = await schedStore.list({ prefix: `schedule/${circuitLetter}/` });

    if (schedBlobs.length > 0) {
      const weekMap = {};
      for (const b of schedBlobs) {
        const data = await schedStore.get(b.key, { type: 'json' }).catch(() => null);
        if (!data?.matches) continue;
        if (data.circuit && data.circuit !== circuitLetter) continue; // season isolation
        if (divisionFilter && data.division !== divisionFilter) continue;

        const w = data.week || 1;
        if (!weekMap[w]) weekMap[w] = { week: w, division: data.division, matches: [] };
        for (const m of data.matches) {
          // Total games won across both rounds (available once finalized).
          const gamesA = (m.round1?.homeGames ?? 0) + (m.round2?.homeGames ?? 0);
          const gamesB = (m.round1?.awayGames ?? 0) + (m.round2?.awayGames ?? 0);

          weekMap[w].matches.push({
            id: m.id,
            teamA: m.teamA?.name || 'TBD',
            teamB: m.teamB?.name || 'TBD',
            teamAId: m.teamA?.id || null,
            teamBId: m.teamB?.id || null,
            emojiA: (m.teamA?.id && emojiById[m.teamA.id]) || '',
            emojiB: (m.teamB?.id && emojiById[m.teamB.id]) || '',
            court: m.court || null,
            venue: m.venue || null,
            courtA: m.courtA ?? null,
            courtB: m.courtB ?? null,
            courtSet: m.courtSet ?? null,
            scheduledAt: m.scheduledAt || null,
            startTime: m.startTime || null,
            scoreA: m.scoreA ?? null,
            scoreB: m.scoreB ?? null,
            // schedule.html renders finals from homeRoundPts/awayRoundPts (= match points)
            homeRoundPts: m.scoreA ?? null,
            awayRoundPts: m.scoreB ?? null,
            // Games-won tally (round1 + round2), shown under the match-points score
            gamesA: m.finalizedAt ? gamesA : null,
            gamesB: m.finalizedAt ? gamesB : null,
            // Per-round results — used by standings week snapshots to tally W/L/T
            // per round (2 rounds/match) the same way the live blob does.
            round1: m.finalizedAt && m.round1 ? {
              homeGames: m.round1.homeGames ?? 0, awayGames: m.round1.awayGames ?? 0,
              homePoints: m.round1.homePoints ?? null, awayPoints: m.round1.awayPoints ?? null,
            } : null,
            round2: m.finalizedAt && m.round2 ? {
              homeGames: m.round2.homeGames ?? 0, awayGames: m.round2.awayGames ?? 0,
              homePoints: m.round2.homePoints ?? null, awayPoints: m.round2.awayPoints ?? null,
            } : null,
            finalizedAt: m.finalizedAt || null,
            status: m.finalizedAt ? 'final' : 'scheduled',
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
          emojiA: emojiByName[(m.homeTeamName || '').toLowerCase()] || '',
          emojiB: emojiByName[(m.awayTeamName || '').toLowerCase()] || '',
          court: m.court || null,
          venue: m.venue || null,
          courtSet: m.courtSet ?? null,
          date: m.date || null,
          scheduledAt: m.scheduledAt || null,
          startTime: m.startTime || null,
          status: m.status || 'scheduled',
          division: m.division,
          divisionLabel: m.divisionLabel || '',
          // Include scores for finalized matches
          homeRoundPts: m.homeRoundPts ?? null,
          awayRoundPts: m.awayRoundPts ?? null,
          gamesA: m.homeGameWins ?? null,
          gamesB: m.awayGameWins ?? null,
          finalizedAt: m.finalizedAt || (m.status === 'final' ? true : null),
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

// Build emoji lookups (by team id and by lowercased name) for a season.
// Best-effort: never throws — an empty map just means no logos.
async function loadTeamEmojis(seasonId) {
  const byId = {};
  const byName = {};
  try {
    const store = getStore('teams');
    const { blobs } = await store.list();
    for (const blob of blobs) {
      const raw = await store.get(blob.key).catch(() => null);
      if (!raw) continue;
      try {
        const team = JSON.parse(raw);
        if (team.seasonId && team.seasonId !== seasonId) continue;
        if (!team.seasonId && seasonId !== 'circuit-i') continue;
        if (!team.emoji) continue;
        if (team.id) byId[team.id] = team.emoji;
        if (team.name) byName[team.name.toLowerCase()] = team.emoji;
      } catch {}
    }
  } catch {}
  return { byId, byName };
}

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
