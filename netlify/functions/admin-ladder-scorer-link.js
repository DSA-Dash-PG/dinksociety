// netlify/functions/admin-ladder-scorer-link.js
// GET ?event=<id>  (admin session required)
// Mint a shareable per-night SCORING link for one ladder. Whoever opens it can
// run that night's scoreboard (scores, subs, finish) with no admin login. The
// link expires after the night, and is scoped to this one event.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getEvent, eventStartMs } from './lib/ladder.js';
import { makeScorerToken } from './lib/ladder-scorer.js';
import { siteUrl } from './lib/ladder-notify.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

const HOURS = 60 * 60 * 1000;

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);
  const event = await getEvent(eventId);
  if (!event) return json({ error: 'Ladder not found' }, 404);

  // Valid through the night: 12h after start, but always at least 8h from now so
  // a link generated mid-night (or re-generated) keeps working.
  const base = eventStartMs(event) ?? Date.parse(`${event.date}T12:00:00`);
  const expiresMs = Math.max((Number.isFinite(base) ? base : Date.now()) + 12 * HOURS, Date.now() + 8 * HOURS);

  const token = makeScorerToken(eventId, expiresMs);
  const url = `${siteUrl()}/ladder-score.html?event=${encodeURIComponent(eventId)}&t=${encodeURIComponent(token)}`;
  return json({ ok: true, url, expiresAt: new Date(expiresMs).toISOString(), eventName: event.name });
};

export const config = { path: '/.netlify/functions/admin-ladder-scorer-link' };
