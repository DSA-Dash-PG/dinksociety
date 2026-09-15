// netlify/functions/lib/lineup-rules.js
// Pure, dependency-free lineup rules shared by captain-lineup.js (and unit-tested).

// Nightly per-player game cap — the single source of truth. lineup-helpers.js
// derives the minimum roster depth from this, and the captain portal / rules page
// quote it, so changing this number moves every downstream rule with it.
//
// RULE CHANGE 2026-09-15: raised from 4 to 6 games per player per night.
// At 6, the minimum legal roster is 2 women + 2 men (12 women-slots / 6 = 2, and
// the same for men), so a 2F/2M team can field a full legal 12-game lineup.
export const MAX_GAMES_PER_NIGHT = 6;

/** When the current cap took effect — surfaced in UI copy so the change is traceable. */
export const MAX_GAMES_RULE_EFFECTIVE = '2026-09-15';

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
