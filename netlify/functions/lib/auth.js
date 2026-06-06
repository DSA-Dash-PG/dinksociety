// netlify/functions/lib/auth.js
// Centralized session verification for all three auth domains.
//
// Thin wrappers around the existing guards — requireAdmin (lib/admin-auth.js),
// requireCaptain (lib/captain-auth.js), requirePlayer (lib/player-auth.js).
// The validation logic is unchanged; this just normalizes the three different
// failure styles (throw vs. null) into one uniform shape:
//
//   { valid: true, payload: {...} }            on success
//   { valid: false, error: 'Unauthorized' }    on failure
//
// `event` is the Netlify Functions v2 Request object, same as every handler
// in this codebase receives.

import { requireAdmin } from './admin-auth.js';
import { requireCaptain } from './captain-auth.js';
import { requirePlayer } from './player-auth.js';

/**
 * Validate the admin_session cookie.
 * payload = { email }
 */
export async function verifyAdminSession(event) {
  try {
    const admin = await requireAdmin(event); // throws when invalid
    return { valid: true, payload: admin };
  } catch {
    return { valid: false, error: 'Unauthorized' };
  }
}

/**
 * Validate the ds_captain_session cookie.
 * payload = { session: { id, email }, team, user: { email, role } }
 */
export async function verifyCaptainSession(event) {
  try {
    const ctx = await requireCaptain(event); // null when invalid
    if (!ctx) return { valid: false, error: 'Unauthorized' };
    return { valid: true, payload: ctx };
  } catch {
    return { valid: false, error: 'Unauthorized' };
  }
}

/**
 * Validate the ds_player_session cookie.
 * payload = { session: { id, email }, playerId, teamId, team, player }
 */
export async function verifyPlayerSession(event) {
  try {
    const ctx = await requirePlayer(event); // null when invalid
    if (!ctx) return { valid: false, error: 'Unauthorized' };
    return { valid: true, payload: ctx };
  } catch {
    return { valid: false, error: 'Unauthorized' };
  }
}

/**
 * Shared 401 response (same JSON body the per-domain unauthResponse
 * helpers produce), so callers only need this one import.
 */
export function unauthResponse(error = 'Unauthorized') {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
