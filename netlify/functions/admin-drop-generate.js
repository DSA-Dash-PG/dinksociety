// netlify/functions/admin-drop-generate.js
// Admin-triggered "Draft with Claude" — runs the generator on demand so Richard
// can produce/refresh a week's draft without waiting for the Tuesday cron.
//
//   POST { circuit?, week?, force? }  (admin session required)
//     week  omitted → latest played week
//     force true     → regenerate even over an existing auto/manual draft
//
// Always lands as a DRAFT. Approval/publish stays in admin-drop.js.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { generateDropDraft } from './lib/drop-generate.js';

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
    const result = await generateDropDraft(body.circuit || 'I', { week: body.week || null, force: !!body.force });
    if (!result.ok) return json({ ok: false, reason: result.reason, week: result.week }, 200);
    return json({ ok: true, week: result.week, status: result.status });
  } catch (e) {
    console.error('admin-drop-generate failed:', e);
    return json({ error: e.message || 'Generation failed' }, 500);
  }
};

export const config = { path: '/.netlify/functions/admin-drop-generate' };
