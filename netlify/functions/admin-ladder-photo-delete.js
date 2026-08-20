// netlify/functions/admin-ladder-photo-delete.js
// POST /api/admin-ladder-photo-delete — remove a ladder photo. ADMIN ONLY.
//
// Deliberately narrower than upload: an organizer can add photos to their own
// night (ladder-photo-upload.js) but cannot remove any, including their own.
// Deletion is destructive and unrecoverable — the binaries go with the record —
// so it stays with the league owner.
//
// Body: { eventId, id }  — or { eventId, ids:[...] } to remove several.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { deletePhoto, getPhoto } from './lib/ladder-photos.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = await verifyAdminSession(req);
  if (!admin.valid) return unauthResponse(admin.error);

  const b = await req.json().catch(() => ({}));
  const eventId = String(b.eventId || '').trim();
  const ids = Array.isArray(b.ids) ? b.ids : (b.id ? [b.id] : []);
  if (!eventId || !ids.length) return json({ error: 'eventId and id (or ids) are required.' }, 400);

  let removed = 0, missing = 0;
  for (const id of ids.slice(0, 200)) {
    const rec = await getPhoto(eventId, id);
    if (!rec) { missing++; continue; }
    await deletePhoto(eventId, id);
    removed++;
  }

  return json({ ok: true, removed, missing });
};

export const config = { path: '/.netlify/functions/admin-ladder-photo-delete' };
