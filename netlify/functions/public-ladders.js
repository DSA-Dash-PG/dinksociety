// netlify/functions/public-ladders.js
// GET /api/public-ladders   (no auth) — what players see on the Ladders page.
// Lists open/live ladders with public signup counts (no emails). One optional
// ?event=<id> returns just that ladder.

import { listEvents, getEvent, getSignups, toPublicSignups, effectiveCapacity } from './lib/ladder.js';

function pub(e, s) {
  const p = toPublicSignups(e, s);
  return {
    id: e.id, name: e.name, date: e.date, startTime: e.startTime, endTime: e.endTime, place: e.place,
    courts: e.courts, type: e.type || 'mixed', feeCents: e.feeCents, status: e.status || 'open',
    capacity: effectiveCapacity(e), spotsLeft: p.spotsLeft,
    rosterCount: p.rosterCount, waitlistCount: p.waitlistCount,
    paymentMethods: e.paymentMethods || ['card', 'venmo'],
    venmoHandle: e.venmoHandle || null,
    roster: p.roster,
  };
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=15' },
  });
}

export default async (req) => {
  const id = new URL(req.url).searchParams.get('event');
  if (id) {
    const e = await getEvent(id);
    if (!e) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return json({ ladder: pub(e, await getSignups(id)) });
  }
  const events = await listEvents();
  const visible = events.filter(e => ['open', 'full', 'live'].includes(e.status || 'open'));
  const ladders = await Promise.all(visible.map(async e => pub(e, await getSignups(e.id))));
  return json({ ladders });
};

export const config = { path: '/.netlify/functions/public-ladders' };
