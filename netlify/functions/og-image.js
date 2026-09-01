// netlify/functions/og-image.js
//
// THE LINK-PREVIEW IMAGE, RESOLVED AT REQUEST TIME.
//
// Every page used to hard-code the same /img/og-image.png, so a link texted from
// any page showed one picture — and it went stale the moment the season's hero
// image changed. Messages.app, Slack, Twitter and friends don't run JavaScript,
// so the page can't fix this on the client: the answer has to come from the URL
// itself. Each page now points og:image at
//
//     /.netlify/functions/og-image?p=<slot>
//
// and this redirects to whatever image that page is actually showing right now.
//
// Resolution order (first hit wins):
//   1. the named Site Images slot   (admin → Site Images; same slots the heroes use)
//   2. the current season's hero image  (season record `image`)
//   3. the site-wide "hero" slot
//   4. /img/og-image.png            (the shipped default — never a broken preview)
//
// The redirect is cached for ten minutes, so swapping a hero image in admin
// changes the share card within the hour rather than needing a deploy. Previews
// already cached on someone's phone keep the old picture — that's the platform,
// not us.

import { getStore } from '@netlify/blobs';
import { currentSeasonInfo } from './lib/current-season.js';

const DEFAULT_IMAGE = '/img/og-image.png';
const CACHE = 'public, max-age=600, stale-while-revalidate=3600';

// Slots the admin Site Images tab knows about. Anything else falls straight
// through to the season/hero/default chain rather than 404ing a preview.
const SLOTS = new Set([
  'hero', 'divider-1', 'divider-2', 'cta', 'schedule', 'standings', 'stats',
  'teams', 'rules', 'gallery', 'register', 'leaderboard', 'contact', 'scrapbook',
]);

async function slotImage(slots, name) {
  const list = name && slots ? slots[name] : null;
  const first = Array.isArray(list) ? list.find(i => i && i.id) : null;
  return first ? `/.netlify/functions/site-images-serve?id=${first.id}` : null;
}

async function currentSeasonImage() {
  try {
    const store = getStore('seasons');
    const { blobs } = await store.list();
    const seasons = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(s => s && s.status !== 'archived' && s.status !== 'draft');
    if (!seasons.length) return null;
    const info = currentSeasonInfo(seasons, Date.now());
    const cur = info && seasons.find(s => s.id === info.id);
    return (cur && cur.image) || null;
  } catch {
    return null;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const asked = (url.searchParams.get('p') || '').trim().toLowerCase();
  const page = SLOTS.has(asked) ? asked : '';

  let target = null;
  try {
    const store = getStore('site-images');
    const slots = await store.get('slots.json', { type: 'json' }).catch(() => null);
    target = await slotImage(slots, page);
    if (!target) target = await currentSeasonImage();
    if (!target) target = await slotImage(slots, 'hero');
  } catch {
    target = null;
  }

  const location = new URL(target || DEFAULT_IMAGE, url.origin).toString();
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': CACHE },
  });
};

export const config = { path: '/.netlify/functions/og-image' };
