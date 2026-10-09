// netlify/functions/lib/roster-lock.js
//
// When a team's roster locks — the one rule, shared by captain-roster.js (which
// enforces it) and lib/team-split.js (which freezes fee shares on it).
//
// A roster stays open through the season's LOCK WEEK and locks once that week
// has been played. An admin can reopen a single team with team.rosterUnlocked.
//
//   Default: Week 2.
//   Season 2 (II): Week 8 — the season was extended to a 10-week double
//   round-robin on 2026-10-09 and players can be added through Week 8.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './circuit.js';

const DEFAULT_LOCK_WEEK = 2;
const LOCK_WEEK_BY_SEASON = { II: 8 };

export function rosterLockWeek(circuit) {
  return LOCK_WEEK_BY_SEASON[circuitCode(circuit)] || DEFAULT_LOCK_WEEK;
}

// Has this week been played, as far as this team is concerned? (pure)
//   • the team has a match that week → once that match is final
//   • no match that week (a bye, or the team's season already ended) → once
//     every match that week is final
// Bracket placeholders with no teams yet are never final, so they never lock.
export function weekPlayedFor(weekData, teamId) {
  const matches = weekData?.matches || [];
  if (!matches.length) return false;
  const mine = matches.find(m => m.teamA?.id === teamId || m.teamB?.id === teamId);
  if (mine) return !!mine.finalizedAt;
  return matches.every(m => !!m.finalizedAt);
}

export async function isRosterLocked(team, { strong = false } = {}) {
  if (!team || team.rosterUnlocked === true) return false;   // admin override
  try {
    const store = strong ? getStore({ name: 'schedule', consistency: 'strong' }) : getStore('schedule');
    const key = `schedule/${circuitCode(team.circuit)}/${team.division}/week-${rosterLockWeek(team.circuit)}.json`;
    const data = await store.get(key, { type: 'json' }).catch(() => null);
    return weekPlayedFor(data, team.id);
  } catch {
    return false;   // never block a save because the lock check itself errored
  }
}
