// netlify/functions/lib/ladder-next.js
// One place that knows how to generate "the round after these rounds" for
// every ladder format, so the live "Next round" action (admin-ladder-round.js)
// and the fix-a-past-round cascade (admin-ladder-score.js) can never disagree:
//   individual    → genNR      (winners up / losers down every game)
//   fixed-partner → genNRPairs (same, at pair granularity)
//   round-robin   → genNRBlock (courts locked for a block of 3, then top 2 up /
//                               bottom 2 down on block wins → diff → DR)

import { listPlay, toSession, playersFromPlay } from './ladder-play.js';
import { genNR, genNRPairs, genNRBlock, calcStats, calcDinkRating, buildStrengthFn, BLOCK_ROUNDS } from './ladder-scoring.js';

export const FORMATS = ['individual', 'fixed-partner', 'round-robin'];
export const isRoundRobin = event => event?.format === 'round-robin';

// Finished play records for OTHER events (the "history" the strength fn and
// season DR are built from).
async function priorPlays(eventId) {
  return (await listPlay()).filter(p => p.finished && p.eventId !== eventId);
}

export async function strengthFor(eventId, players) {
  const prior = (await priorPlays(eventId)).map(toSession);
  return buildStrengthFn(prior, players);
}

// Season DR (prior finished nights + tonight so far) → { playerId: dr|null }.
// Used as the third tiebreak at a Round Robin block boundary, matching the
// season rule (wins → point diff → DR).
export async function drMapFor(eventId, play) {
  const plays = [...(await priorPlays(eventId)), play].filter(Boolean);
  const sessions = plays.map(toSession);
  const players = playersFromPlay(plays);
  if (!players.length) return {};
  return calcDinkRating(calcStats(sessions, players), sessions, players) || {};
}

// Generate the round that follows `rounds` (all rounds so far, in order) for
// this event/play. `participants` = engine-shape roster (only needed for the
// individual format's strength fn).
export async function nextRound({ event, play, rounds, eventId, participants = [] }) {
  const courts = play.config?.courts || event.courts || 1;
  const cur = rounds[rounds.length - 1];
  if (event.format === 'fixed-partner') return genNRPairs(cur, courts);
  if (isRoundRobin(event)) {
    const drMap = await drMapFor(eventId, { ...play, rounds });
    return genNRBlock(rounds, courts, drMap, play.config?.block || BLOCK_ROUNDS);
  }
  const strength = await strengthFor(eventId, participants);
  return genNR(cur, courts, strength);
}
