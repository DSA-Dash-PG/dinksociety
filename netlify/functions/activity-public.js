// netlify/functions/activity-public.js
// Anonymous public-page view beacon. No session, no PII.
// POST { path, vid? } — vid is a random per-browser id from localStorage,
// used only to estimate daily uniques. Rolls into pageview/<day>.json.
// Fire-and-forget on the client (sendBeacon); always answers 204.

import { recordPageview } from './lib/activity-log.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response(null, { status: 204 });

  let body = {};
  try { body = await req.json(); } catch { /* sendBeacon may post text */ }
  const path = typeof body.path === 'string' ? body.path : null;
  const vid = typeof body.vid === 'string' ? body.vid.slice(0, 64) : null;

  if (path) await recordPageview({ path, vid });
  return new Response(null, { status: 204 }); // never error a beacon
};

export const config = { path: '/.netlify/functions/activity-public' };
