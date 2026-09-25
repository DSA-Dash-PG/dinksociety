// netlify/functions/drop-photo-serve.js
// Streams a Drop photo (cover, gallery shot, or storyline thumbnail) from the
// 'drop-photos' blob store.
// Called as: /.netlify/functions/drop-photo-serve?id=<imageId>
// Public — no auth (published Drops are visible to all visitors).

import { getStore } from '@netlify/blobs';

const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id || !VALID_ID.test(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  try {
    const store = getStore('drop-photos');
    const result = await store.getWithMetadata(`img/${id}`, { type: 'arrayBuffer' });

    if (!result || !result.data) {
      return new Response('Not found', { status: 404 });
    }

    const contentType = result.metadata?.contentType || 'image/jpeg';

    // ?dl=1[&name=...] → save-as download with a readable filename (the
    // lightbox Download button). The name is sanitized to [a-z0-9-].
    const headers = {
      'Content-Type': contentType,
        // Drop photos are immutable once uploaded (a new photo = a new id), so we
        // can cache hard.
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (url.searchParams.get('dl') === '1') {
      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const base = String(url.searchParams.get('name') || `dink-society-${id}`).toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'dink-society-photo';
      headers['Content-Disposition'] = `attachment; filename="${base}.${ext}"`;
    }
    return new Response(result.data, { status: 200, headers });
  } catch (err) {
    console.error('drop-photo-serve error:', err);
    return new Response('Error loading image', { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/drop-photo-serve' };
