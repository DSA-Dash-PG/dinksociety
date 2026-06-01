// =============================================================
// POST /.netlify/functions/admin-reset
//
// Clears all season data from blob stores:
//   seasons, teams, matches, standings, registrations, leaderboard
//
// Does NOT touch: admin-sessions, admin-magic-links, site-images,
//                 captain sessions, or circuit settings.
// Admin-only endpoint.
// =============================================================

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

async function clearStore(name) {
  const store = getStore(name);
  const { blobs } = await store.list();
  await Promise.all(blobs.map(({ key }) => store.delete(key).catch(() => null)));
  return blobs.length;
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try { await requireAdmin(req); } catch { return unauthResponse(); }

  const stores = ['seasons', 'teams', 'matches', 'standings', 'registrations', 'leaderboard'];
  const counts = {};

  for (const name of stores) {
    counts[name] = await clearStore(name);
  }

  return new Response(JSON.stringify({ ok: true, deleted: counts }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
