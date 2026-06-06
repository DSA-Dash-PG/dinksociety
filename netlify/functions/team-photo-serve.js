// netlify/functions/team-photo-serve.js
// Streams a team photo from the 'team-photos' blob store.
// Called as: /.netlify/functions/team-photo-serve?id=<teamId>
// Public — no auth (team photos are visible to all visitors).

import { getStore } from '@netlify/blobs';

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id || !VALID_ID.test(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  try {
    const store = getStore('team-photos');
    const result = await store.getWithMetadata(`img/${id}`, { type: 'arrayBuffer' });

    if (!result || !result.data) {
      return new Response('Not found', { status: 404 });
    }

    const contentType = result.metadata?.contentType || 'image/jpeg';

    return new Response(result.data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // Short max-age + SWR: photos can change, but the public page also
        // appends ?v=<updatedAt> so a changed photo busts cache immediately.
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    console.error('team-photo-serve error:', err);
    return new Response('Error loading image', { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/team-photo-serve' };
