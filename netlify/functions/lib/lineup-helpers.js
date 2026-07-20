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
 * Set pairing: g1+g2, g3+g4, g5+g6 within each round are played
 * SIMULTANEOUSLY on two courts, so one player can't appear in both games
 * of a pair. Returns an error string or null. Mirrors the client-side
 * graying in the captain lineup builder.
 */
export function checkSimultaneousPairs(games, rosterById) {
  for (let round = 1; round <= 2; round++) {
    for (let g = 1; g <= 6; g += 2) {
      const a = games[`r${round}g${g}`] || {};
      const b = games[`r${round}g${g + 1}`] || {};
      const inB = new Set([b.p1, b.p2].filter(Boolean));
      const dupe = [a.p1, a.p2].filter(Boolean).find(id => inB.has(id));
      if (dupe) {
        const name = rosterById?.get?.(dupe)?.name || 'A player';
        return `${name} is in both G${g} and G${g + 1} of Round ${round} — those games are played at the same time on different courts.`;
      }
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

// Season-configurable defaults — keep in sync with UI copy in captain.html / me.html.
export const DEFAULT_LOCK_OFFSET_MIN = 60;    // lineups hard-lock 1 hour before match start
export const DEFAULT_REVEAL_OFFSET_MIN = 15;  // matchup reveals 15 minutes before match start

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

/**
 * The instant a matchup is allowed to reveal: match start − offset (in minutes).
 * Same shape as hardLockTime. Null when the match has no scheduled time.
 */
export function revealTime(scheduledAt, offsetMin = DEFAULT_REVEAL_OFFSET_MIN) {
  return hardLockTime(scheduledAt, offsetMin);
}

/**
 * Time gate for the simultaneous reveal: true once we're within `offsetMin`
 * minutes of match start. FAILS CLOSED: a match with no scheduled time never
 * reveals (admin must set scheduledAt — see admin "Set match times" backfill).
 * Failing open here leaked opponent lineups days early the moment both
 * captains locked (June 2026 Season 1 bug). Both-locked is checked by
 * callers — this is ONLY the clock half of
 * `revealed = bothLocked && isRevealTime(...)`.
 */
export function isRevealTime(scheduledAt, offsetMin = DEFAULT_REVEAL_OFFSET_MIN) {
  const t = revealTime(scheduledAt, offsetMin);
  return t !== null && Date.now() >= t;
}

/** Human-friendly offset, e.g. 180 → "3 hours", 30 → "30 minutes". */
export function formatOffset(min) {
  if (min % 60 === 0) {
    const h = min / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${min} minutes`;
}

export const GAMES_PER_ROUND = 6;

/**
 * Display game number, 1-12 continuous across the night.
 * Round 1 is Games 1-6, Round 2 is Games 7-12.
 *
 * Storage keys stay `r1g1`..`r2g6` — this is presentation only. Never persist
 * the 1-12 number or key anything by it.
 *
 * Deliberately NO optional gamesPerRound parameter: these get used point-free
 * (`SLOT_KEYS.map(gameNoOf)`), and Array.map passes the index as the second
 * argument, which would silently corrupt every number after the first. The
 * slot grid is fixed at 6 games per round by SLOT_RULES regardless.
 */
export function gameNo(round, gameInRound) {
  return (Number(round) - 1) * GAMES_PER_ROUND + Number(gameInRound);
}

/** Same, straight from a slot key: gameNoOf('r2g4') === 10. */
export function gameNoOf(slot) {
  const m = /^r(\d+)g(\d+)$/.exec(String(slot || ''));
  return m ? gameNo(m[1], m[2]) : null;
}

/** Human slot type: "Women's doubles" | "Men's doubles" | "Mixed doubles". */
export function slotTypeLabel(slot) {
  const type = SLOT_RULES[slot];
  return type === 'WOMENS' ? 'Women’s doubles'
    : type === 'MENS' ? 'Men’s doubles'
    : 'Mixed doubles';
}

export function prettySlot(slot) {
  return `Game ${gameNoOf(slot)} (${slotTypeLabel(slot)})`;
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
