// =============================================================
// POST /api/admin-wipe-test-season
//
// One-button teardown of the isolated test season. Deletes ONLY the
// test-season data (TEST circuit / circuit-test / team-test- prefixes)
// across seasons, teams, schedule, scores, lineups, standings and
// player-stats. Real seasons are never touched.
//
// Admin-only.
// =============================================================

import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import { wipeTestSeason } from './lib/test-season.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  try {
    const deleted = await wipeTestSeason();
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    return new Response(JSON.stringify({ ok: true, deleted, total }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('admin-wipe-test-season error:', err);
    return new Response(JSON.stringify({ error: 'Wipe failed', detail: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/admin-wipe-test-season' };
