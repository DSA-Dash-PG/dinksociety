// netlify/functions/public-ladder-recaps.js
// GET /.netlify/functions/public-ladder-recaps   (no auth)
// Teasers for the most recent SENT ladder-night recaps, for the "Latest
// nights" strip on the ladders page. Redacted: title, dek, podium names +
// records only — no emails, no per-player stories, no draft content.

import { listEvents } from './lib/ladder.js';
import { recapTeaser } from './lib/ladder-recap-teaser.js';

export default async () => {
  const events = (await listEvents({}))
    .filter(e => (e.status || '') === 'final')
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 8);

  const recaps = [];
  for (const e of events) {
    if (recaps.length >= 3) break;
    const t = await recapTeaser(e);   // null until the recap has been sent
    if (t) recaps.push(t);
  }

  return new Response(JSON.stringify({ recaps }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};

export const config = { path: '/.netlify/functions/public-ladder-recaps' };
