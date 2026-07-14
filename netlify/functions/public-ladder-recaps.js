// netlify/functions/public-ladder-recaps.js
// GET /.netlify/functions/public-ladder-recaps   (no auth)
// Teasers for the most recent SENT ladder-night recaps, for the "Latest
// nights" strip on the ladders page. Redacted: title, dek, podium names +
// records only — no emails, no per-player stories, no draft content.

import { listEvents } from './lib/ladder.js';
import { getRecap } from './lib/ladder-recap.js';

export default async () => {
  const events = (await listEvents({}))
    .filter(e => (e.status || '') === 'final')
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 8);

  const recaps = [];
  for (const e of events) {
    if (recaps.length >= 3) break;
    const r = await getRecap(e.id).catch(() => null);
    if (!r || r.status !== 'sent' || !r.recap) continue;
    recaps.push({
      eventId: e.id,
      name: e.name || 'Ladder',
      date: e.date || null,
      place: e.place || null,
      courts: e.courts || null,
      rounds: e.rounds || null,
      playersCount: Array.isArray(r.recipients) ? r.recipients.length : null,
      title: r.recap.title || null,
      dek: r.recap.dek || null,
      podium: (r.recap.podium || []).slice(0, 3).map(p => ({
        name: p.name || '',
        w: p.w ?? null,
        l: p.l ?? null,
      })),
    });
  }

  return new Response(JSON.stringify({ recaps }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};

export const config = { path: '/.netlify/functions/public-ladder-recaps' };
