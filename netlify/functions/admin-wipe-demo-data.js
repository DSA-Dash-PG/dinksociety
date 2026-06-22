// =============================================================
// POST /api/admin-wipe-demo-data
//
// Removes ONLY the demo season seeded by seed-demo-data.js. Scoped strictly to
// the demo identity (circuit-demo / DEMO / demo-* / team-demo- / lb-demo- /
// reg-demo-) plus the isTest marker — it can never touch a real season.
//
// Admin-only. Returns delete counts per store.
// =============================================================

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { wipeDemoData } from './lib/demo-data.js';
import { guardSeedRun } from './lib/seed-lock.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  // Cooldown so a double-click can't fire two wipes back-to-back.
  const guard = await guardSeedRun('demo-wipe', 15000);
  if (!guard.ok) {
    return json({ error: 'Wiped too recently — please wait a moment.', retryInMs: guard.retryInMs }, 429);
  }

  try {
    const deleted = await wipeDemoData();
    const total = Object.values(deleted).reduce((n, v) => n + v, 0);
    return json({ ok: true, deleted, total });
  } catch (err) {
    console.error('admin-wipe-demo-data error:', err);
    return json({ error: 'Wipe failed', detail: err.message }, 500);
  }
};

export const config = { path: '/.netlify/functions/admin-wipe-demo-data' };
