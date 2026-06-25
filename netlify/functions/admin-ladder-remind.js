// netlify/functions/admin-ladder-remind.js
// POST /api/admin-ladder-remind  (admin session required)
// Manually push a ladder reminder to the whole roster right now.
// Body: { eventId, kind: 'two_day'|'morning'|'three_hour', force? (default true) }

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getEvent, getSignups } from './lib/ladder.js';
import { sendEventReminder, REMINDER_KINDS } from './lib/ladder-reminders.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const b = await req.json().catch(() => ({}));
  if (!b.eventId || !b.kind) return json({ error: 'eventId and kind are required' }, 400);
  if (!REMINDER_KINDS.includes(b.kind)) return json({ error: 'kind must be one of ' + REMINDER_KINDS.join(', ') }, 400);

  const event = await getEvent(b.eventId);
  if (!event) return json({ error: 'Event not found' }, 404);
  const signups = await getSignups(b.eventId);

  const res = await sendEventReminder(event, signups, b.kind, { force: b.force !== false });
  return json(res, res.ok ? 200 : 400);
};

export const config = { path: '/.netlify/functions/admin-ladder-remind' };
