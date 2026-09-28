// netlify/functions/track.js
// Page-view beacon for the admin Traffic page (see lib/traffic.js).
// POST from public/js/ds-track.js: start / hb (every 30s while active) /
// hide / end. Same-origin, so the sign-in cookies ride along and the view can
// be attributed to a player or captain. Always answers 204 — never error a beacon.

import { recordHit } from './lib/traffic.js';

export default async (req, context) => {
  if (req.method !== 'POST') return new Response(null, { status: 204 });
  let body = null;
  try {
    const text = await req.text(); // sendBeacon may arrive as text/plain
    if (text && text.length < 4000) body = JSON.parse(text);
  } catch { /* ignore */ }
  if (body && typeof body === 'object') await recordHit(body, req, context);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: '/.netlify/functions/track' };
