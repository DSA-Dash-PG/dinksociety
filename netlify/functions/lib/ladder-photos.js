// netlify/functions/lib/ladder-photos.js
// Shared helpers for ladder night photos — the 'ladder-photos' Blobs store.
//
// A photo belongs to exactly ONE ladder night (its eventId). That single
// association is what lets the same upload surface in three places without any
// extra bookkeeping: the division gallery (queen.html), that night's results
// overlay, and its recap article.
//
// Layout in the store:
//   img/<id>              full-resolution binary   (metadata: { contentType })
//   thumb/<id>            small binary for grids   (metadata: { contentType })
//   meta/<eventId>/<id>.json   the record below
//
// Two sizes is deliberate. A 15-photo night is 40-50MB at full resolution; a
// grid that loaded those directly would crawl on a phone. The grid reads
// thumb/, and only the lightbox and the download button pull img/.
//
// The meta key is prefixed by eventId so listing one night's photos is a single
// prefixed list() rather than a scan-and-filter over every photo ever uploaded.

import { getStore } from '@netlify/blobs';

export const PHOTO_STORE = 'ladder-photos';
export const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
export const MAX_BYTES = 6 * 1024 * 1024;   // Lambda payload ceiling
export const MAX_CAPTION = 140;

export const store = () => getStore(PHOTO_STORE);

/** Ids are used in URLs and filenames — keep them to a safe charset. */
export const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export function photoId(eventId) {
  let r;
  try {
    r = crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  } catch {
    r = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  return `p_${String(eventId || 'x').slice(0, 16)}_${r}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

const metaKey = (eventId, id) => `meta/${eventId}/${id}.json`;

/**
 * Every photo for one night, newest-uploaded last (upload order = display
 * order, which is what people expect from an album). A cover photo, if one is
 * flagged, is hoisted to the front.
 */
export async function listPhotos(eventId) {
  if (!eventId) return [];
  const s = store();
  let keys = [];
  try {
    const { blobs } = await s.list({ prefix: `meta/${eventId}/` });
    keys = (blobs || []).map(b => b.key);
  } catch {
    return [];   // store not provisioned yet — an empty album, not an error
  }
  const rows = await Promise.all(keys.map(k => s.get(k, { type: 'json' }).catch(() => null)));
  return sortPhotos(rows.filter(Boolean));
}

/** Every photo across every night, grouped later by the caller. */
export async function listAllPhotos() {
  const s = store();
  let keys = [];
  try {
    const { blobs } = await s.list({ prefix: 'meta/' });
    keys = (blobs || []).map(b => b.key);
  } catch {
    return [];
  }
  const rows = await Promise.all(keys.map(k => s.get(k, { type: 'json' }).catch(() => null)));
  return rows.filter(Boolean);
}

/** Cover first, then admin-set order (ord), then oldest-uploaded first.
    `ord` is written by the Photos tab's ◀ ▶ reorder controls — photos without
    one (older uploads) fall in after the ordered ones, by upload time. */
export function sortPhotos(rows) {
  return rows.sort((a, b) => {
    if (!!b.cover !== !!a.cover) return b.cover ? 1 : -1;
    const ao = Number.isFinite(a.ord) ? a.ord : Infinity;
    const bo = Number.isFinite(b.ord) ? b.ord : Infinity;
    if (ao !== bo) return ao - bo;
    return String(a.uploadedAt || '').localeCompare(String(b.uploadedAt || ''));
  });
}

export async function getPhoto(eventId, id) {
  if (!eventId || !id) return null;
  return store().get(metaKey(eventId, id), { type: 'json' }).catch(() => null);
}

export async function putPhoto(rec) {
  await store().setJSON(metaKey(rec.eventId, rec.id), rec);
  return rec;
}

/**
 * Remove a photo completely — both binaries and the record. Each delete is
 * tolerated individually so a half-written upload (binary stored, meta never
 * written, or vice versa) can still be cleaned up rather than wedging.
 */
export async function deletePhoto(eventId, id) {
  const s = store();
  await Promise.all([
    s.delete(`img/${id}`).catch(() => {}),
    s.delete(`thumb/${id}`).catch(() => {}),
    s.delete(metaKey(eventId, id)).catch(() => {}),
  ]);
}

/** Clear the cover flag on every other photo for this night. */
export async function clearCovers(eventId, exceptId) {
  const rows = await listPhotos(eventId);
  await Promise.all(rows
    .filter(r => r.cover && r.id !== exceptId)
    .map(r => putPhoto({ ...r, cover: false })));
}

/**
 * A human-readable download filename: "amazing-ladies-3-2026-08-18-04.jpg"
 * rather than a blob id. Position is 1-based within the night.
 */
export function downloadName(event, rec, position) {
  const slug = String(event?.name || 'ladder')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ladder';
  const date = String(event?.date || '').slice(0, 10) || 'undated';
  const ext = rec.contentType === 'image/png' ? 'png' : rec.contentType === 'image/webp' ? 'webp' : 'jpg';
  const n = String(position || 1).padStart(2, '0');
  return `${slug}-${date}-${n}.${ext}`;
}

/** Public shape — never leaks the uploader's email. */
export function toPublic(rec, i = 0) {
  return {
    id: rec.id,
    eventId: rec.eventId,
    caption: rec.caption || '',
    cover: !!rec.cover,
    w: rec.w || null,
    h: rec.h || null,
    bytes: rec.bytes || null,
    uploadedAt: rec.uploadedAt || null,
    // Focal point (percentages, 0–100) for object-position crops; null = center.
    fx: Number.isFinite(rec.fx) ? rec.fx : null,
    fy: Number.isFinite(rec.fy) ? rec.fy : null,
    ord: Number.isFinite(rec.ord) ? rec.ord : null,
    url: `/.netlify/functions/ladder-photo-serve?id=${encodeURIComponent(rec.id)}`,
    thumb: `/.netlify/functions/ladder-photo-serve?id=${encodeURIComponent(rec.id)}&size=thumb`,
    download: `/.netlify/functions/ladder-photo-serve?id=${encodeURIComponent(rec.id)}&dl=1`,
    n: i + 1,
  };
}
