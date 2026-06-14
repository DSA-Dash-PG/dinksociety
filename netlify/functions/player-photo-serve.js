// netlify/functions/player-photo-serve.js
// Streams an APPROVED player photo from the 'player-photos' blob store.
// Called as: /.netlify/functions/player-photo-serve?id=<playerId>
// Public — no auth. Only the approved img/<playerId> is ever served here;
// pending uploads (pending/<playerId>) are never exposed publicly.
//
// Admins preview a pending photo via player-photo-serve?id=<playerId>&pending=1
// (admin session required for the pending variant).

import { getStore } from '@netlify/blobs';
import { verifyAdminSession } from './lib/auth.js';

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const wantPending = url.searchParams.get('pending') === '1';

  if (!id || !VALID_ID.test(id)) {
    return new Response('Invalid id', { status: 400 });
  }

  try {
    // Pending preview is admin-only.
    let key = `img/${id}`;
    if (wantPending) {
      const admin = await verifyAdminSession(req);
      if (!admin.valid) return new Response('Unauthorized', { status: 401 });
      key = `pending/${id}`;
    }

    const store = getStore('player-photos');
    const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });

    if (!result || !result.data) {
      return new Response('Not found', { status: 404 });
    }

    const contentType = result.metadata?.contentType || 'image/jpeg';

    return new Response(result.data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // Pages append ?v=<updatedAt> so a changed photo busts cache immediately.
        'Cache-Control': wantPending
          ? 'private, no-store'
          : 'public, max-age=3600, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    console.error('player-photo-serve error:', err);
    return new Response('Error loading image', { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/player-photo-serve' };
