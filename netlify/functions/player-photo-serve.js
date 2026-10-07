// netlify/functions/player-photo-serve.js
// Streams an APPROVED player photo from the 'player-photos' blob store.
// Called as: /.netlify/functions/player-photo-serve?id=<playerId>
// Public — no auth. Only the approved img/<playerId> is ever served here;
// pending uploads (pending/<playerId>) are never exposed publicly.
//
// Admins preview a pending photo via player-photo-serve?id=<playerId>&pending=1
// (admin session required for the pending variant) — or, from the approval
// email, with &t=<view token> (lib/approval-token.js) so the <img> renders in
// the inbox without a sign-in. The token must be for this exact player.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession } from './lib/auth.js';
import { peekApprovalToken } from './lib/approval-token.js';
import { identityIdsFor } from './lib/league-identity.js';
import { photoResolver } from './lib/player-photo.js';

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
      const viewTok = url.searchParams.get('t');
      let allowed = false;
      if (viewTok) {
        const rec = await peekApprovalToken(viewTok);
        allowed = !!rec && rec.action === 'view' && rec.playerId === id;
      }
      if (!allowed) {
        const admin = await verifyAdminSession(req);
        if (!admin.valid) return new Response('Unauthorized', { status: 401 });
      }
      key = `pending/${id}`;
    }

    const store = getStore('player-photos');
    let result = null;

    if (!wantPending) {
      // ONE answer per person: whatever id a page passes (any season's roster
      // id, a ladder id), serve that person's current avatar — the newest
      // approved photo across all their ids (lib/player-photo.js). This is
      // what keeps home, team, player, captain and "me" pages in agreement.
      const src = (await photoResolver().catch(() => null))?.sourceFor(id)?.src;
      if (src) result = await store.getWithMetadata(`img/${src}`, { type: 'arrayBuffer' }).catch(() => null);
    }
    if (!result || !result.data) {
      result = await store.getWithMetadata(key, { type: 'arrayBuffer' }).catch(() => null);
    }

    // Not in the index yet (an id minted since it was built)? Walk the
    // identity layer directly.
    if ((!result || !result.data) && !wantPending) {
      const ids = await identityIdsFor(id).catch(() => []);
      for (const other of ids) {
        if (other === id) continue;
        const r = await store.getWithMetadata(`img/${other}`, { type: 'arrayBuffer' }).catch(() => null);
        if (r && r.data) { result = r; break; }
      }
    }

    if (!result || !result.data) {
      return new Response('Not found', { status: 404 });
    }

    const contentType = result.metadata?.contentType || 'image/jpeg';

    return new Response(result.data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // Versioned URLs (?v=<approvedAt>, emitted by lib/player-photo.js)
        // change whenever the avatar changes, so they can cache long. A bare
        // ?id= URL must stay short-lived or an admin's new photo would hide
        // behind the old one for a day.
        'Cache-Control': wantPending
          ? 'private, no-store'
          : (url.searchParams.get('v')
              ? 'public, max-age=86400, stale-while-revalidate=604800'
              : 'public, max-age=60, stale-while-revalidate=300'),
      },
    });
  } catch (err) {
    console.error('player-photo-serve error:', err);
    return new Response('Error loading image', { status: 500 });
  }
};

export const config = { path: '/.netlify/functions/player-photo-serve' };
