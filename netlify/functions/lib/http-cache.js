// netlify/functions/lib/http-cache.js
//
// ETag-aware JSON responses for endpoints that get polled.
//
// How the "live refresh" pipeline works (ESPN-style, scaled down):
//   1. Score entry writes blobs; rebuildStandings writes pre-computed blobs.
//   2. Read endpoints serve those blobs through etagJson() below.
//   3. Clients poll with If-None-Match (see public/js/live-poll.js).
//      Unchanged data → 304 with an empty body, so a poll costs almost
//      nothing. For public endpoints, a short CDN max-age absorbs most
//      polls before they even reach the function.
//
// Usage:
//   import { etagJson } from './lib/http-cache.js';
//   return etagJson(req, data);                            // public, 5s CDN
//   return etagJson(req, data, { cacheControl: PRIVATE }); // authed payloads

import { createHash } from 'node:crypto';

// Public endpoints: let Netlify's CDN serve repeat polls for 5s, and serve
// stale (while refreshing in the background) for another 30s. Fifty viewers
// polling every 10s mostly hit the edge cache, not the function.
export const PUBLIC_LIVE = 'public, max-age=5, stale-while-revalidate=30';

// Authed per-user payloads: never cached by CDN or browser. The ETag still
// lets our poller short-circuit with a 304 when nothing changed.
export const PRIVATE = 'private, no-store';

export function etagJson(req, data, { cacheControl = PUBLIC_LIVE, status = 200 } = {}) {
  const body = JSON.stringify(data);
  // Weak ETag: same JSON → same tag. Hash the serialized body so callers
  // don't need to think about it.
  const etag = 'W/"' + createHash('sha1').update(body).digest('base64url') + '"';

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': cacheControl,
    'ETag': etag,
  };

  // If-None-Match may carry several comma-separated tags.
  const inm = req.headers.get('if-none-match');
  if (inm && status === 200 && inm.split(',').map(s => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(body, { status, headers });
}
