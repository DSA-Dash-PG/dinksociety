// netlify/functions/ladder-photo-upload.js
// POST /api/ladder-photo-upload — attach a photo to one ladder night.
//
// multipart/form-data: eventId, file, thumb (optional), caption, cover, w, h
//
// Auth: admin, OR the active organizer who owns this ladder (requireLadderOwner
// enforces exactly that split). Deletion is deliberately NOT mirrored here —
// it stays admin-only, in admin-ladder-photo-delete.js.
//
// The client resizes before uploading and sends TWO blobs: `file` (full size,
// capped around 2000px) and `thumb` (~480px, for the gallery grid). Doing the
// resize in the browser keeps this function dependency-free — no sharp, no
// native binary in the Netlify build. If `thumb` is missing the full image is
// stored under both keys, so the gallery still works, just heavier.

import { requireLadderOwner, orgErr } from './lib/organizer-auth.js';
import {
  store, photoId, putPhoto, clearCovers,
  ALLOWED_TYPES, MAX_BYTES, MAX_CAPTION,
} from './lib/ladder-photos.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let form;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'Expected multipart/form-data.' }, 400);
  }

  const eventId = String(form.get('eventId') || '').trim();
  if (!eventId) return json({ error: 'eventId is required.' }, 400);

  // Admin, or the organizer who owns THIS ladder. Anyone else is refused before
  // a single byte is written.
  const auth = await requireLadderOwner(req, eventId);
  if (!auth.ok) return orgErr(auth);

  const file = form.get('file');
  const thumb = form.get('thumb');
  const caption = String(form.get('caption') || '').slice(0, MAX_CAPTION).trim();
  const cover = String(form.get('cover') || '') === 'true';
  const w = parseInt(form.get('w'), 10) || null;
  const h = parseInt(form.get('h'), 10) || null;

  if (!file || typeof file === 'string') return json({ error: 'No file provided.' }, 400);
  if (!ALLOWED_TYPES.has(file.type)) return json({ error: 'Only JPG, PNG or WebP images are allowed.' }, 400);
  if (file.size > MAX_BYTES) {
    return json({
      error: `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit. `
           + `The uploader normally shrinks photos before sending — try re-picking the file.`,
    }, 400);
  }

  const id = photoId(eventId);
  const s = store();
  // eventId rides along on the binary's metadata so the serve endpoint can find
  // the parent night (for the download filename) without parsing the id.
  const meta = { contentType: file.type, eventId };

  try {
    await s.set(`img/${id}`, await file.arrayBuffer(), { metadata: meta });

    const thumbOk = thumb && typeof thumb !== 'string' && ALLOWED_TYPES.has(thumb.type) && thumb.size <= MAX_BYTES;
    await s.set(
      `thumb/${id}`,
      thumbOk ? await thumb.arrayBuffer() : await file.arrayBuffer(),
      { metadata: { contentType: thumbOk ? thumb.type : file.type, eventId } },
    );

    const rec = {
      id, eventId, caption, cover,
      w, h,
      bytes: file.size,
      contentType: file.type,
      uploadedAt: new Date().toISOString(),
      uploadedBy: auth.email || '',
      uploadedByRole: auth.role || 'admin',
    };
    await putPhoto(rec);
    // Only one cover per night — flagging a new one demotes the old.
    if (cover) await clearCovers(eventId, id).catch(() => {});

    return json({ ok: true, id, url: `/.netlify/functions/ladder-photo-serve?id=${encodeURIComponent(id)}` });
  } catch (err) {
    console.error('ladder-photo-upload error:', err);
    return json({ error: 'Upload failed.', detail: err.message }, 500);
  }
};

export const config = { path: '/.netlify/functions/ladder-photo-upload' };
