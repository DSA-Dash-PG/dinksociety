// netlify/functions/public-ladder-home.js
// GET /.netlify/functions/public-ladder-home   (no auth)
//
// Everything the home page (and the nav's "New" tag on Ladders) needs to know
// about the ladders, in one call: the next ladder and how full it is, the last
// finished ladder's podium, and the newest ladder write-ups with their publish
// times. See lib/ladder-home.js for the shape and the rules.
//
// Cached for a minute at the edge and in the browser: spots left can be that
// stale on the home page; the hub (public-ladders) stays the live source at
// sign-up time.

import { buildLadderHome } from './lib/ladder-home.js';

export default async () => {
  let body;
  try {
    body = await buildLadderHome();
  } catch (err) {
    console.error('public-ladder-home error:', err);
    body = { next: null, last: null, writeups: [] };
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
};

export const config = { path: '/.netlify/functions/public-ladder-home' };
