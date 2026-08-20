// netlify/functions/public-ladder-photos.js
// GET /api/public-ladder-photos               → every night that has photos
// GET /api/public-ladder-photos?event=<id>    → just that night
// GET /api/public-ladder-photos?type=womens   → every women's night with photos
//
// Public — no auth. Returns albums newest night first, photos within a night in
// upload order with any cover photo hoisted to the front.
//
// Private ladders are excluded from the LIST (same rule public-ladders.js uses:
// an invite-only night shouldn't be discoverable by browsing), but an explicit
// ?event=<id> lookup still works, so the direct link an organizer shared by hand
// keeps showing its photos.

import { listEvents, getEvent } from './lib/ladder.js';
import { listPhotos, listAllPhotos, sortPhotos, toPublic } from './lib/ladder-photos.js';

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
  });
}

const album = (event, photos) => ({
  eventId: event.id,
  name: event.name || 'Ladder',
  date: event.date || null,
  place: event.place || null,
  type: event.type || 'mixed',
  count: photos.length,
  photos: photos.map(toPublic),
});

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const eventId = params.get('event');
  const type = params.get('type');

  // ── one night (works for private ladders too — you had to have the id) ──
  if (eventId) {
    const event = await getEvent(eventId).catch(() => null);
    if (!event) return json({ albums: [], total: 0 });
    const photos = await listPhotos(eventId);
    return json({ albums: photos.length ? [album(event, photos)] : [], total: photos.length });
  }

  // ── browse ──
  // One list() over every photo record, then group — cheaper than a per-event
  // list call for each of a growing number of ladders.
  const [all, events] = await Promise.all([listAllPhotos(), listEvents().catch(() => [])]);
  const byEvent = new Map();
  for (const rec of all) {
    if (!rec?.eventId) continue;
    if (!byEvent.has(rec.eventId)) byEvent.set(rec.eventId, []);
    byEvent.get(rec.eventId).push(rec);
  }

  const albums = events
    .filter(e => byEvent.has(e.id))
    .filter(e => e.visibility !== 'private')
    .filter(e => !type || (e.type || 'mixed') === type)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .map(e => album(e, sortPhotos(byEvent.get(e.id))));

  return json({ albums, total: albums.reduce((n, a) => n + a.count, 0) });
};

export const config = { path: '/.netlify/functions/public-ladder-photos' };
