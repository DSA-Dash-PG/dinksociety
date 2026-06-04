// netlify/functions/lib/lineup-rules.js
// Pure, dependency-free lineup rules shared by captain-lineup.js (and unit-tested).

export const MAX_GAMES_PER_NIGHT = 4;

/**
 * Woman-first ordering for mixed doubles: returns { p1, p2 } with the woman as p1.
 * Pass the two player ids and a gender lookup (id -> 'M' | 'F').
 * Non-mixed slots are returned unchanged.
 */
export function orderMixedWomanFirst(slotType, p1Id, p2Id, genderOf) {
  if (slotType !== 'MIXED') return { p1: p1Id, p2: p2Id };
  if (genderOf(p1Id) === 'M' && genderOf(p2Id) === 'F') return { p1: p2Id, p2: p1Id };
  return { p1: p1Id, p2: p2Id };
}

/**
 * Nightly per-player game cap. `games` is a map of slotKey -> { p1, p2 }.
 * Returns an error string if any player exceeds `max`, else null.
 * `nameOf` maps a player id to a display name (optional).
 */
export function checkGameCap(games, nameOf = (id) => id, max = MAX_GAMES_PER_NIGHT) {
  const counts = new Map();
  for (const picks of Object.values(games || {})) {
    for (const id of [picks?.p1, picks?.p2]) {
      if (!id) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  for (const [id, n] of counts) {
    if (n > max) {
      const name = nameOf(id) || 'A player';
      return `${name} is in ${n} games — the max is ${max} games per player per night.`;
    }
  }
  return null;
}
