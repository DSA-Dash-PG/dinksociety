// netlify/functions/public-ladder-badge.js
// PUBLIC (no auth) — the live "spots left" badge image embedded in ladder emails.
//
//   GET /.netlify/functions/public-ladder-badge?event=<id>
//     → image/png rendered from the CURRENT signup count, so it refreshes when an
//       email client re-fetches the image (Apple Mail/Outlook update on open;
//       Gmail's proxy caches, so there it stays near send-time — that's why the
//       email also bakes the number into HTML as the source of truth).
//
// Never throws to the client: any problem returns a 1x1 transparent PNG so a
// broken <img> never appears in the email.

import { getEvent, getSignups, spotsLeft, effectiveCapacity } from './lib/ladder.js';
import { renderSpotsPng, transparentPng } from './lib/spots-badge.js';

const PUBLIC_STATUSES = ['open', 'full', 'live', 'final'];

function pngResponse(buf, { cache }) {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // no-store so clients that DO re-fetch always get the live count
      'Cache-Control': cache || 'no-store, no-cache, must-revalidate, max-age=0',
    },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const blank = () => pngResponse(transparentPng(), { cache: 'no-store' });

  try {
    const eventId = new URL(req.url).searchParams.get('event');
    if (!eventId) return blank();

    const event = await getEvent(eventId);
    if (!event) return blank();
    if (!PUBLIC_STATUSES.includes(event.status || 'open')) return blank();

    const signups = await getSignups(eventId);
    const left = spotsLeft(event, signups);
    const cap = effectiveCapacity(event);
    if (!cap) return blank();

    return pngResponse(renderSpotsPng({ left, cap }), {});
  } catch (err) {
    console.error('public-ladder-badge error:', err);
    return blank();
  }
};

export const config = { path: '/.netlify/functions/public-ladder-badge' };
