// netlify/functions/lib/availability.js
// Per-match player availability for lineups.
//
// Model: players are AVAILABLE by default. We only persist an explicit record
// when someone (the player, or a captain on their behalf) marks a status.
//   status: 'in'  → explicitly available
//   status: 'out' → unavailable; excluded from the lineup builder (hard block)
// Absence of a record = "no response" = treated as available.
//
// Blob store 'availability', one record per team per match:
//   availability/<matchId>/<teamId>.json
//   { matchId, teamId, players: { <playerId>: {status, reason, updatedAt, updatedBy, byRole} }, updatedAt }
//
// Strong consistency: the captain's lineup builder reads this right after a
// player/captain writes it, and an eventual replica could hand back the stale
// copy — the same class of bug we fixed for scores ([[blobs-strong-consistency]]).

import { getStore } from '@netlify/blobs';

const STORE = 'availability';
const REASON_MAX = 200;

const recKey = (matchId, teamId) => `availability/${matchId}/${teamId}.json`;

function availStore() {
  return getStore({ name: STORE, consistency: 'strong' });
}

/**
 * Read the availability record for one team in one match.
 * Always returns a normalized shape (never null) so callers can read .players safely.
 */
export async function getTeamAvailability(matchId, teamId) {
  const rec = await availStore().get(recKey(matchId, teamId), { type: 'json' }).catch(() => null);
  return {
    matchId,
    teamId,
    players: (rec && rec.players) ? rec.players : {},
    updatedAt: rec?.updatedAt || null,
  };
}

/**
 * Set one player's status for a match. status is coerced to 'in' | 'out'.
 * Returns the updated (normalized) record.
 */
export async function setPlayerAvailability({ matchId, teamId, playerId, status, reason, byEmail, byRole }) {
  const rec = await getTeamAvailability(matchId, teamId);
  const norm = status === 'out' ? 'out' : 'in';
  const players = { ...(rec.players || {}) };
  players[playerId] = {
    status: norm,
    reason: norm === 'out' ? String(reason || '').trim().slice(0, REASON_MAX) : '',
    updatedAt: new Date().toISOString(),
    updatedBy: byEmail || null,
    byRole: byRole === 'captain' ? 'captain' : 'player',
  };
  const updated = { matchId, teamId, players, updatedAt: new Date().toISOString() };
  await availStore().setJSON(recKey(matchId, teamId), updated);
  return updated;
}

/** Set of playerIds marked 'out' in a normalized record. */
export function unavailableIds(rec) {
  const out = new Set();
  for (const [pid, v] of Object.entries(rec?.players || {})) {
    if (v?.status === 'out') out.add(pid);
  }
  return out;
}

/** True if the given player is explicitly marked unavailable. */
export function isUnavailable(rec, playerId) {
  return rec?.players?.[playerId]?.status === 'out';
}
