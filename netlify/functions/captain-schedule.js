// netlify/functions/captain-schedule.js
// Returns the captain's matches across all weeks of the current Circuit.
// Each match includes court assignment and opponent team NAME (team name
// is public) but NOT opponent lineup details.

import { getStore } from '@netlify/blobs';
import { requireCaptain, unauthResponse } from './lib/captain-auth.js';

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const { id: teamId, division, circuit } = ctx.team;
  const scheduleStore = getStore('schedule');
  const lineupStore = getStore('lineups');

  try {
    const myMatches = [];

    // Scan all weeks for this division in this circuit
    for (let week = 1; week <= 7; week++) {
      const key = `schedule/${circuit}/${division}/week-${week}.json`;
      const data = await scheduleStore.get(key, { type: 'json' });
      if (!data?.matches) continue;

      for (const m of data.matches) {
        const isHome = m.teamA?.id === teamId;
        const isAway = m.teamB?.id === teamId;
        if (!isHome && !isAway) continue;

        const myRole = isHome ? 'home' : 'away';
        const opponent = isHome ? m.teamB : m.teamA;

        // Check lineup lock status
        const myLineupKey = `lineup/${m.id}/${teamId}.json`;
        const oppLineupKey = `lineup/${m.id}/${opponent.id}.json`;
        const [myLineup, oppLineup] = await Promise.all([
          lineupStore.get(myLineupKey, { type: 'json' }).catch(() => null),
          lineupStore.get(oppLineupKey, { type: 'json' }).catch(() => null),
        ]);

        const myLocked = !!myLineup?.lockedAt;
        const oppLocked = !!oppLineup?.lockedAt;
        const revealed = myLocked && oppLocked;

        myMatches.push({
          id: m.id,
          week,
          circuit,
          division,
          court: m.court || null,
          venue: m.venue || null,
          scheduledAt: m.scheduledAt || null,
          myRole,
          opponent: {
            id: opponent.id,
            name: opponent.name,
          },
          status: {
            myLocked,
            oppLocked,
            revealed,
          },
          scoreA: m.scoreA ?? null,
          scoreB: m.scoreB ?? null,
          finalizedAt: m.finalizedAt || null,
        });
      }
    }

    myMatches.sort((a, b) => a.week - b.week);

    return new Response(JSON.stringify({ matches: myMatches }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
    });
  } catch (err) {
    console.error('captain-schedule error:', err);
    return new Response(JSON.stringify({ error: 'Failed to load schedule' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/captain-schedule' };
