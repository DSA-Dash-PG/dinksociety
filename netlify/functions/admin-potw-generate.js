// netlify/functions/admin-potw-generate.js
// Admin-triggered "prepare the Player of the Week approval emails" — runs the
// same logic as potw-email-cron on demand so Richard can generate (or, with
// force, regenerate) a week's approval email without waiting for the Tuesday
// cron. Always lands as a pending draft and emails the approval to the admin
// address; nothing reaches a member until the one-tap Approve is used.
//
//   POST { force? }   (admin session required)
//     force true → re-prepare even if the latest week was already prepared

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { prepareWeeklyPotwApproval } from './lib/potw-email.js';
import { liveCircuit } from './lib/current-season.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  let body = {};
  try { body = await req.json(); } catch {}
  try {
    // The admin's working season wins; otherwise whichever season is live.
    const circuit = (body.circuit || '').trim() || await liveCircuit();
    const result = await prepareWeeklyPotwApproval(circuit, { force: !!body.force });
    return json(result, 200);
  } catch (e) {
    console.error('admin-potw-generate failed:', e);
    return json({ error: e.message || 'Generation failed' }, 500);
  }
};

export const config = { path: '/.netlify/functions/admin-potw-generate' };
