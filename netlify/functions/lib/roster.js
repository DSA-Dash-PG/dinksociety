// netlify/functions/lib/roster.js
//
// WHO COUNTS AS BEING ON A ROSTER.
//
// Two flags take a player out of play, for different reasons:
//
//   archived   — they were on the team and have been taken off (captain-owned).
//   pendingAdd — a captain has ASKED to add them and the league hasn't approved
//                it yet. They sit on the team record so the captain can see
//                their own request, but they are not on the team: no lineups,
//                no availability nudges, no public roster, no roster health.
//
// Every read that means "the players on this team" goes through here, so a new
// exclusion rule lands in one place instead of a dozen `!p.archived` filters.

/** A player who is actually on the roster right now. */
export function isActivePlayer(p) {
  return !!p && !p.archived && !p.pendingAdd;
}

/** The team's real roster. */
export function activeRoster(team) {
  return ((team && team.roster) || []).filter(isActivePlayer);
}

/** Adds a captain has requested and the league hasn't ruled on. */
export function pendingAdds(team) {
  return ((team && team.roster) || []).filter(p => p && p.pendingAdd);
}
