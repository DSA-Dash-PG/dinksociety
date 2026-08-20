// netlify/functions/ladder-photo-update.js
// POST /api/ladder-photo-update — edit a photo's caption, or make it the cover.
//
// Body: { eventId, id, caption?, cover? }
//
// Same permission as upload (admin, or the organizer who owns this ladder) —
// captioning is part of adding a photo, not part of removing one. Deletion
// stays admin-only in admin-ladder-photo-delete.js.

import { requireLadderOwner, orgErr } from './lib/organizer-auth.js';
import { getPhoto, putPhoto, clearCovers, MAX_CAPTION } from './lib/ladder-photos.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const b = await req.json().catch(() => ({}));
  const eventId = String(b.eventId || '').trim();
  const id = String(b.id || '').trim();
  if (!eventId || !id) return json({ error: 'eventId and id are required.' }, 400);

  const auth = await requireLadderOwner(req, eventId);
  if (!auth.ok) return orgErr(auth);

  const rec = await getPhoto(eventId, id);
  if (!rec) return json({ error: 'Photo not found.' }, 404);

  // Field by field — an omitted key leaves the stored value alone, so editing a
  // caption never silently clears the cover flag (and vice versa).
  const next = { ...rec };
  if (b.caption !== undefined) next.caption = String(b.caption || '').slice(0, MAX_CAPTION).trim();
  if (b.cover !== undefined) next.cover = !!b.cover;

  await putPhoto(next);
  if (next.cover && !rec.cover) await clearCovers(eventId, id).catch(() => {});

  return json({ ok: true, photo: { id: next.id, caption: next.caption, cover: next.cover } });
};

export const config = { path: '/.netlify/functions/ladder-photo-update' };
