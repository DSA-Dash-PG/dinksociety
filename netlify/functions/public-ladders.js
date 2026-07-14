// netlify/functions/public-ladders.js
// GET /api/public-ladders   (no auth) — what players see on the Ladders page.
// Lists open/live ladders with public signup counts (no emails). One optional
// ?event=<id> returns just that ladder.

import { listEvents, getEvent, getSignups, toPublicSignups, effectiveCapacity } from './lib/ladder.js';
import { getDirectory, applyDirectoryToSignups } from './lib/player-directory.js';

function pub(e, s) {
  const p = toPublicSignups(e, s);
  return {
    id: e.id, name: e.name, date: e.date, startTime: e.startTime, endTime: e.endTime, place: e.place,
    courts: e.courts, courtNames: e.courtNames || [], courtNumbers: e.courtNumbers || null,
    type: e.type || 'mixed', feeCents: e.feeCents, status: e.status || 'open',
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
  const dir = await getDirectory();
  const id = new URL(req.url).searchParams.get('event');
  if (id) {
    const e = await getEvent(id);
    if (!e) return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return json({ ladder: pub(e, applyDirectoryToSignups(await getSignups(id), dir)) });
  }
  const events = await listEvents();
  const visible = events.filter(e => ['open', 'full', 'live'].includes(e.status || 'open'));
  const ladders = (await Promise.all(visible.map(async e => pub(e, applyDirectoryToSignups(await getSignups(e.id), dir)))))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const completed = events.filter(e => (e.status || 'open') === 'final')
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .map(e => ({ id: e.id, name: e.name, date: e.date, place: e.place, type: e.type || 'mixed' }));
  return json({ ladders, completed });
};

export const config = { path: '/.netlify/functions/public-ladders' };
