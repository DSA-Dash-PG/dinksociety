// netlify/functions/lib/live-results.js
//
// Pure helpers for two related things:
//
//   1. SUSPENDED (carried-over) matches — a night that was rained out part way
//      through. The admin "suspends" the match: every game confirmed so far is
//      FROZEN (its score is final and can no longer be edited), both lineups
//      are reopened so captains can change who plays the remaining games, and
//      the remainder is played at `resumeAt`. The schedule match carries:
//
//        m.suspended = {
//          at, by,                 // when / which admin
//          resumeAt,               // ISO — when the remaining games are played
//          lockedSlots: ['r1g1'…], // frozen games (scores final)
//          snapshot: { … },        // confirmed-game totals at suspend time
//          note,                   // optional admin note shown to captains
//        }
//
//      The reveal / hard-lock clock for the REMAINING games runs off resumeAt
//      (effectiveStart), while the frozen games stay public — they were already
//      revealed and played.
//
//   2. LIVE (unofficial) results — a match counts toward the standings and
//      player stats as soon as it has started and at least one game is
//      confirmed, not only once both captains have signed off. Those matches
//      are flagged `provisional` all the way to the page; the finalize is what
//      makes them official.
//
// No storage, auth or request handling here.

import { SLOT_KEYS, gameStatus } from './score-helpers.js';

/** A match is suspended while it carries a suspension and is not yet final. */
export function isSuspended(match) {
  return !!(match?.suspended && !match.finalizedAt);
}

/** Frozen (score-final) game slots of a suspended match, as a Set. */
export function frozenSlots(match) {
  const list = isSuspended(match) ? (match.suspended.lockedSlots || []) : [];
  return new Set(list.filter(s => SLOT_KEYS.includes(s)));
}

/**
 * When the match (or its remaining games) starts: the resume time for a
 * suspended match, else the scheduled time. This is what the lineup hard-lock
 * and the matchup reveal are measured against.
 */
export function effectiveStart(match) {
  if (!match) return null;
  if (isSuspended(match) && match.suspended.resumeAt) return match.suspended.resumeAt;
  return match.scheduledAt || null;
}

/** True once the match's ORIGINAL start time has passed. */
export function matchStarted(match, now = Date.now()) {
  const iso = match?.scheduledAt;
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t <= now;
}

/** Slots whose score is confirmed (both entries agree, valid game). */
export function confirmedSlots(score, championship = false) {
  const out = new Set();
  if (!score?.games) return out;
  const winBy = championship ? 2 : 1;
  for (const slot of SLOT_KEYS) {
    if (gameStatus(score.games[slot], winBy) === 'confirmed') out.add(slot);
  }
  return out;
}

/**
 * Does this match count toward the standings right now?
 *   final      → yes (official)
 *   started + ≥1 confirmed game → yes, provisionally (live / unofficial)
 *   otherwise  → no
 * Returns 'final' | 'live' | null.
 */
export function countState(match, score, now = Date.now()) {
  if (!match) return null;
  if (match.finalizedAt || score?.finalizedAt) return 'final';
  if (!matchStarted(match, now)) return null;
  if (!confirmedSlots(score, !!match.championship).size) return null;
  return 'live';
}

/**
 * Which lineup slots may be shown publicly. Every slot once the matchup is
 * revealed (or the match is final); otherwise only the frozen games of a
 * suspended match — those were revealed and played on the original night, and
 * reopening the lineups for the remaining games must not hide them again.
 * Returns a predicate (slot) → boolean.
 */
export function lineupSlotVisible(match, revealedAll) {
  if (revealedAll) return () => true;
  const frozen = frozenSlots(match);
  return (slot) => frozen.has(slot);
}

/** Public, PII-free view of a suspension for payloads. */
export function publicSuspension(match) {
  if (!isSuspended(match)) return null;
  const s = match.suspended;
  return {
    at: s.at || null,
    resumeAt: s.resumeAt || null,
    lockedSlots: (s.lockedSlots || []).slice(),
    lockedCount: (s.lockedSlots || []).length,
    remaining: SLOT_KEYS.length - (s.lockedSlots || []).length,
    snapshot: s.snapshot || null,
    note: s.note || null,
    originalScheduledAt: s.originalScheduledAt || match.scheduledAt || null,
  };
}

/**
 * Round-level view of a set of confirmed games: how many games of each round
 * are confirmed. Used to count ROUNDS played for an in-progress match.
 */
export function roundsComplete(score, championship = false) {
  const conf = confirmedSlots(score, championship);
  let n = 0;
  for (const r of [1, 2]) {
    let c = 0;
    for (let g = 1; g <= 6; g++) if (conf.has(`r${r}g${g}`)) c++;
    if (c === 6) n++;
  }
  return n;
}
