// netlify/functions/moments-image.js
// Streams an image from the 'moments' Netlify Blobs store.
// Called as: /.netlify/functions/moments-image?id=<id>

import { getStore } from '@netlify/blobs';

export default async (req, context) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id || !/^[a-f0-9]{16}$/.test(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  try {
    const store = getStore('moments');
    const result = await store.getWithMetadata(`img/${id}`, { type: 'arrayBuffer' });

    if (!result || !result.data) {
      return new Response('Not found', { status: 404 });
    }

    const contentType = result.metadata?.contentType || 'image/jpeg';

    return new Response(result.data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    console.error('moments-image error:', err);
    return new Response('Error loading image', { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/moments-image' };
