// netlify/functions/captain-schedule.js
// Returns the captain's matches across all weeks of the current Circuit.
// Each match includes court assignment and opponent team NAME (team name
// is public) but NOT opponent lineup details.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { isRevealTime, DEFAULT_LOCK_OFFSET_MIN } from './lib/lineup-helpers.js';

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  const { id: teamId, division } = ctx.team;
  const circuit = circuitCode(ctx.team.circuit);
  const scheduleStore = getStore('schedule');
  const lineupStore = getStore('lineups');
  const teamsStore = getStore('teams');
  const seasonStore = getStore('seasons');
  const myEmoji = ctx.team.emoji || '';

  // Season-configurable lineup hard-lock offset (minutes before start). The
  // captain UI reads this so its countdowns/locks match the server instead of
  // assuming a hard-coded 60. Keep in sync with captain-lineup.js.
  const seasonData = ctx.team.seasonId
    ? await seasonStore.get(ctx.team.seasonId, { type: 'json' }).catch(() => null)
    : null;
  const lineupLockOffsetMin = Number(seasonData?.lineupLockOffsetMin) || DEFAULT_LOCK_OFFSET_MIN;

  try {
    const myMatches = [];

    // Scan all weeks for this division in this circuit (incl. championship
    // week 8 and any admin-added make-up weeks)
    for (let week = 1; week <= 12; week++) {
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
        const [myLineup, oppLineup, oppTeam] = await Promise.all([
          lineupStore.get(myLineupKey, { type: 'json' }).catch(() => null),
          lineupStore.get(oppLineupKey, { type: 'json' }).catch(() => null),
          teamsStore.get(`team/${opponent.id}.json`, { type: 'json' }).catch(() => null),
        ]);

        const myLocked = !!myLineup?.lockedAt;
        const oppLocked = !!oppLineup?.lockedAt;
        // Simultaneous reveal: both locked AND within 15 min of match start.
        const revealed = myLocked && oppLocked && isRevealTime(m.scheduledAt);

        myMatches.push({
          id: m.id,
          week,
          circuit,
          division,
          court: m.court || null,
          courtA: m.courtA ?? null,
          courtB: m.courtB ?? null,
          championship: !!m.championship,
          venue: m.venue || null,
          scheduledAt: m.scheduledAt || null,
          startTime: m.startTime || null,
          endTime: m.endTime || null,
          myRole,
          myTeam: { id: teamId, name: ctx.team.name, emoji: myEmoji },
          opponent: {
            id: opponent.id,
            name: opponent.name,
            emoji: oppTeam?.emoji || '',
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

    return new Response(JSON.stringify({ matches: myMatches, lineupLockOffsetMin }), {
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
