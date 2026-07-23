// netlify/functions/lib/player-photos.js
//
// Single source of truth for player avatar URLs.
//
// The approved photo binary lives at `player-photos/img/<playerId>` — one key
// per player. Historically each *surface* re-derived a photoUrl from a per-roster
// `photo.updatedAt` stamp instead, and that stamp drifts: it lives on one roster
// record and gets dropped when a player is re-rostered, merged, or the team blob
// is rewritten. Result: the binary exists (profile page shows it) but the
// leaderboard / POTW / team cards emit photoUrl:null and fall back to initials.
//
// loadPhotoIndex() reads the binary store ONCE and returns the set of playerIds
// that truly have a photo, so every surface resolves the avatar the same way.

import { getStore } from '@netlify/blobs';

const PREFIX = 'img/';

// Build the public serve URL. `token` (blob etag or updatedAt) just cache-busts.
export function buildPhotoUrl(id, token) {
  const v = token ? `&v=${encodeURIComponent(token)}` : '';
  return `/.netlify/functions/player-photo-serve?id=${encodeURIComponent(id)}${v}`;
}

// Map(playerId -> etag) of every approved photo binary, or null on failure.
// Returning null (not an empty Map) lets callers fall back to legacy stamp
// behavior on a transient blob error instead of blanking every avatar.
export async function loadPhotoIndex() {
  try {
    const store = getStore('player-photos');
    const index = new Map();
    let cursor;
    do {
      const res = await store.list({ prefix: PREFIX, cursor });
      for (const b of (res.blobs || [])) {
        const id = b.key.slice(PREFIX.length);
        if (id) index.set(id, b.etag || '');
      }
      cursor = res.cursor;
    } while (cursor);
    return index;
  } catch (err) {
    console.error('loadPhotoIndex failed (non-fatal):', err?.message || err);
    return null;
  }
}

// Resolve a player's avatar URL.
//   index present  -> authoritative: URL iff a binary exists, else null.
//   index null     -> degrade to the legacy stamp (never worse than before).
export function photoUrlFor(index, id, stampUpdatedAt) {
  if (!id) return null;
  if (index instanceof Map) {
    return index.has(id) ? buildPhotoUrl(id, index.get(id)) : null;
  }
  return stampUpdatedAt ? buildPhotoUrl(id, stampUpdatedAt) : null;
}
