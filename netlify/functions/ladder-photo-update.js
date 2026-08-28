// netlify/functions/ladder-photo-update.js
// POST /api/ladder-photo-update — edit a photo's caption, cover flag, focal
// point, or the night's photo order.
//
// Body: { eventId, id, caption?, cover?, fx?, fy? }        — one photo
//   or: { eventId, order: [id, id, …] }                    — reorder the night
//
// fx/fy are the focal point as 0–100 percentages (Photos tab → Focus); they
// drive object-position wherever the photo is cover-cropped (recap hero,
// polaroids, tickers, grids). null clears them back to center. `order` writes
// ord = index on each listed photo; sortPhotos still hoists the cover first.
//
// Same permission as upload (admin, or the organizer who owns this ladder) —
// arranging photos is part of adding them, not part of removing one. Deletion
// stays admin-only in admin-ladder-photo-delete.js.

import { requireLadderOwner, orgErr } from './lib/organizer-auth.js';
import { getPhoto, putPhoto, clearCovers, listPhotos, MAX_CAPTION } from './lib/ladder-photos.js';

const pct = v => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null; };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const b = await req.json().catch(() => ({}));
  const eventId = String(b.eventId || '').trim();
  const id = String(b.id || '').trim();
  if (!eventId) return json({ error: 'eventId is required.' }, 400);

  const auth = await requireLadderOwner(req, eventId);
  if (!auth.ok) return orgErr(auth);

  // Reorder the whole night in one write per photo: ord = index in the sent
  // list. Ids not listed keep their record untouched (they sort after).
  if (Array.isArray(b.order)) {
    const ids = b.order.map(x => String(x || '').trim()).filter(Boolean);
    if (!ids.length) return json({ error: 'order must list photo ids.' }, 400);
    const rows = await listPhotos(eventId);
    const byId = new Map(rows.map(r => [r.id, r]));
    await Promise.all(ids.map((pid, i) => {
      const rec = byId.get(pid);
      return rec && rec.ord !== i ? putPhoto({ ...rec, ord: i }) : null;
    }));
    return json({ ok: true, ordered: ids.length });
  }

  if (!id) return json({ error: 'id is required.' }, 400);
  const rec = await getPhoto(eventId, id);
  if (!rec) return json({ error: 'Photo not found.' }, 404);

  // Field by field — an omitted key leaves the stored value alone, so editing a
  // caption never silently clears the cover flag (and vice versa).
  const next = { ...rec };
  if (b.caption !== undefined) next.caption = String(b.caption || '').slice(0, MAX_CAPTION).trim();
  if (b.cover !== undefined) next.cover = !!b.cover;
  if (b.fx !== undefined || b.fy !== undefined) {
    const fx = pct(b.fx), fy = pct(b.fy);
    if (fx == null || fy == null) { delete next.fx; delete next.fy; }   // clear → back to center
    else { next.fx = fx; next.fy = fy; }
  }

  await putPhoto(next);
  if (next.cover && !rec.cover) await clearCovers(eventId, id).catch(() => {});

  return json({ ok: true, photo: { id: next.id, caption: next.caption, cover: next.cover, fx: next.fx ?? null, fy: next.fy ?? null } });
};

export const config = { path: '/.netlify/functions/ladder-photo-update' };
