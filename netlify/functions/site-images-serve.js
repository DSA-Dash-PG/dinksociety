// netlify/functions/site-images-serve.js
// Streams a site image from the 'site-images' Netlify Blobs store.
// Called as: /.netlify/functions/site-images-serve?id=<id>
// Public — no auth required (images must be visible to all visitors).

import { getStore } from '@netlify/blobs';

export default async (req, context) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id || !/^[a-f0-9]{16}$/.test(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  try {
    const store = getStore('site-images');
    const result = await store.getWithMetadata(`img/${id}`, { type: 'arrayBuffer' });

    if (!result || !result.data) {
      return new Response('Not found', { status: 404 });
    }

    const contentType = result.metadata?.contentType || 'image/jpeg';

    return new Response(result.data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      },
    });
  } catch (err) {
    console.error('site-images-serve error:', err);
    return new Response('Error loading image', { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/site-images-serve' };
