// netlify/functions/lib/lineup-helpers.js
// Pure lineup validation/formatting/computation, extracted verbatim from
// captain-lineup.js. No storage, auth, or request handling here.
//
// Slot gender rules:
//   Round 1 & 2 each have 6 games in this order:
//     g1 = Women's Doubles  (both players F)
//     g2 = Men's Doubles    (both players M)
//     g3-g6 = Mixed Doubles (one M + one F — stored woman-first: p1 is always the woman)

import { MAX_GAMES_PER_NIGHT } from './lineup-rules.js';

export const SLOT_RULES = {
  r1g1: 'WOMENS', r1g2: 'MENS', r1g3: 'MIXED', r1g4: 'MIXED', r1g5: 'MIXED', r1g6: 'MIXED',
  r2g1: 'WOMENS', r2g2: 'MENS', r2g3: 'MIXED', r2g4: 'MIXED', r2g5: 'MIXED', r2g6: 'MIXED',
};
export const SLOT_KEYS = Object.keys(SLOT_RULES);

/** No two games within the same round can have the same pair of players. */
export function checkDuplicateCombos(games, roundsPerMatch = 2, gamesPerRound = 6) {
  for (let round = 1; round <= roundsPerMatch; round++) {
    const seen = new Map();
    for (let g = 1; g <= gamesPerRound; g++) {
      const slot = `r${round}g${g}`;
      const picks = games[slot];
      if (!picks?.p1 || !picks?.p2) continue;
      const key = [picks.p1, picks.p2].sort().join('|');
      if (seen.has(key)) {
        return `Round ${round}: same duo (${slot.toUpperCase()}) already plays in ${seen.get(key).toUpperCase()}. No duplicate combos in the same round.`;
      }
      seen.set(key, slot);
    }
  }
  return null;
}

/**
 * Checks: no duplicate combo (same pair of players) in consecutive games
 * within the same round. Same combo IS allowed across Round 1 & Round 2.
 * Returns an error string if a duplicate is found, else null.
 */
export function checkBackToBackCombos(games, rosterById) {
  const rounds = [['r1g1','r1g2','r1g3','r1g4','r1g5','r1g6'],
                  ['r2g1','r2g2','r2g3','r2g4','r2g5','r2g6']];
  for (const round of rounds) {
    const seen = new Set();
    for (const slot of round) {
      const g = games[slot];
      if (!g?.p1 || !g?.p2) continue;
      const key = [g.p1, g.p2].sort().join('|');
      if (seen.has(key)) {
        const p1 = rosterById.get(g.p1)?.name || 'Player 1';
        const p2 = rosterById.get(g.p2)?.name || 'Player 2';
        return `${p1} & ${p2} are already paired earlier in ${slot.startsWith('r1') ? 'Round 1' : 'Round 2'}. Same pair cannot repeat within a round.`;
      }
      seen.add(key);
    }
  }
  return null;
}

export function checkSlotGender(slotType, g1, g2) {
  if (slotType === 'WOMENS') {
    if (g1 === 'F' && g2 === 'F') return { ok: true };
    return { ok: false, reason: 'women’s doubles needs two women' };
  }
  if (slotType === 'MENS') {
    if (g1 === 'M' && g2 === 'M') return { ok: true };
    return { ok: false, reason: 'men’s doubles needs two men' };
  }
  if (slotType === 'MIXED') {
    if ((g1 === 'M' && g2 === 'F') || (g1 === 'F' && g2 === 'M')) return { ok: true };
    return { ok: false, reason: 'mixed doubles needs one woman and one man' };
  }
  return { ok: false, reason: 'unknown slot' };
}

/**
 * Checks the roster can physically fill a legal lineup before a lock.
 * Demand is derived from the slot mix + the nightly per-player game cap, so it
 * stays correct if either the slot rules or MAX_GAMES_PER_NIGHT change.
 * Only players with a gender set ('M'/'F') count — gender-less players can't be
 * placed in a slot. Returns a player-facing error string, or null if OK.
 */
export function checkRosterDepth(roster) {
  let womenDemand = 0, menDemand = 0;
  for (const type of Object.values(SLOT_RULES)) {
    if (type === 'WOMENS') womenDemand += 2;
    else if (type === 'MENS') menDemand += 2;
    else { womenDemand += 1; menDemand += 1; } // MIXED: one of each
  }
  const minWomen = Math.ceil(womenDemand / MAX_GAMES_PER_NIGHT);
  const minMen = Math.ceil(menDemand / MAX_GAMES_PER_NIGHT);

  const women = (roster || []).filter(p => p.gender === 'F').length;
  const men = (roster || []).filter(p => p.gender === 'M').length;
  if (women >= minWomen && men >= minMen) return null;

  const gaps = [];
  if (women < minWomen) {
    const n = minWomen - women;
    gaps.push(`${n} more ${n > 1 ? 'women' : 'woman'}`);
  }
  if (men < minMen) {
    const n = minMen - men;
    gaps.push(`${n} more ${n > 1 ? 'men' : 'man'}`);
  }
  return `Not enough players to fill a lineup. With a ${MAX_GAMES_PER_NIGHT}-game-per-player cap you need at least ${minWomen} women and ${minMen} men (with a gender set) — you have ${women} ${women === 1 ? 'woman' : 'women'} and ${men} ${men === 1 ? 'man' : 'men'}. Add ${gaps.join(' and ')} to your roster, then lock.`;
}

/**
 * The instant a lineup hard-locks: match start − offset (in minutes).
 * Returns a ms timestamp, or null when the match has no scheduled time (in which
 * case there's no time-based lock to enforce). scheduledAt is an ISO timestamp.
 */
export function hardLockTime(scheduledAt, offsetMin) {
  if (!scheduledAt) return null;
  const t = Date.parse(scheduledAt);
  if (Number.isNaN(t)) return null;
  return t - offsetMin * 60000;
}

/** Human-friendly offset, e.g. 180 → "3 hours", 30 → "30 minutes". */
export function formatOffset(min) {
  if (min % 60 === 0) {
    const h = min / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${min} minutes`;
}

export function prettySlot(slot) {
  const round = slot.startsWith('r1') ? 'Round 1' : 'Round 2';
  const gameNum = slot.slice(-1);
  const type = SLOT_RULES[slot];
  const typeLabel = type === 'WOMENS' ? 'Women’s doubles'
    : type === 'MENS' ? 'Men’s doubles'
    : 'Mixed doubles';
  return `${round} Game ${gameNum} (${typeLabel})`;
}

export function sanitizeRevealedLineup(lineup) {
  if (!lineup) return null;
  return {
    teamId: lineup.teamId,
    teamName: lineup.teamName,
    games: lineup.games, // only names + ids, no PII
    lockedAt: lineup.lockedAt,
  };
}
