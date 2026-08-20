// netlify/functions/ladder-photo-serve.js
// GET /.netlify/functions/ladder-photo-serve?id=<id>[&size=thumb][&dl=1]
//
// Public — the ladder gallery is open to visitors, no login. A photo is
// immutable once uploaded (editing means a new upload with a new id), so this
// caches hard, same as drop-photo-serve.js.
//
//   size=thumb  → the small grid version
//   dl=1        → Content-Disposition: attachment with a readable filename
//                 ("amazing-ladies-3-2026-08-18-04.jpg"), so the browser saves
//                 the file instead of navigating to it.

import { store, VALID_ID, getPhoto, listPhotos, downloadName } from './lib/ladder-photos.js';
import { getEvent } from './lib/ladder.js';

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const size = url.searchParams.get('size') === 'thumb' ? 'thumb' : 'img';
  const wantsDownload = url.searchParams.get('dl') === '1';

  if (!id || !VALID_ID.test(id)) return new Response('Invalid id', { status: 400 });

  try {
    const s = store();
    let result = await s.getWithMetadata(`${size}/${id}`, { type: 'arrayBuffer' }).catch(() => null);
    // A thumb can be missing on photos uploaded before thumbnails existed, or if
    // the second write failed — fall back to the full image rather than 404ing.
    if ((!result || !result.data) && size === 'thumb') {
      result = await s.getWithMetadata(`img/${id}`, { type: 'arrayBuffer' }).catch(() => null);
    }
    if (!result || !result.data) return new Response('Not found', { status: 404 });

    const contentType = result.metadata?.contentType || 'image/jpeg';
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    };

    if (wantsDownload) {
      // Name the file after the night it came from. Falling back to the bare id
      // is fine — a download should never fail because a lookup did.
      let filename = `${id}.jpg`;
      try {
        const eventId = result.metadata?.eventId;
        if (eventId) {
          const [event, rec, all] = await Promise.all([
            getEvent(eventId).catch(() => null),
            getPhoto(eventId, id),
            listPhotos(eventId),
          ]);
          if (rec) {
            const position = all.findIndex(p => p.id === id) + 1;
            filename = downloadName(event, rec, position || 1);
          }
        }
      } catch { /* keep the fallback name */ }
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }

    return new Response(result.data, { status: 200, headers });
  } catch (err) {
    console.error('ladder-photo-serve error:', err);
    return new Response('Error loading image', { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/ladder-photo-serve' };
