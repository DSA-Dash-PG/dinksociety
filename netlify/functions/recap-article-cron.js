// netlify/functions/recap-article-cron.js
//
// Netlify SCHEDULED function — publishes the FULL recap article about ten
// minutes after a ladder night is finished, for every ladder, automatically.
//
// Runs every 5 minutes and is a cheap no-op when nothing is due: the only work
// on an idle tick is one blob list of the play records.
//
// Why a 5-minute poll and not an exact 10-minute timer: Netlify schedules are
// cron, not one-shot timers, and the night "finishes" inside another request
// (the scorer tapping Finish), so there is nothing to hang a timer on. A night
// therefore publishes 10–15 minutes after it is marked finished.
//
// Related but separate: ladder-recap-cron.js drafts the short per-player recap
// EMAIL at the 15 minute mark and never sends without admin review. This one
// publishes a public page, which is why it runs first and on its own clock.

import { listPlay } from './lib/ladder-play.js';
import { getArticle } from './lib/recap-article-store.js';
import { generateRecapArticle } from './lib/ladder-recap-article.js';

const MIN_AGE_MS = 10 * 60 * 1000;        // the ten minutes Richard asked for
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // don't trawl the archive on every tick
const MAX_PER_RUN = 3;                    // a 10s function vs a ~20s Claude call

export default async () => {
  const out = [];
  try {
    const plays = await listPlay();
    const now = Date.now();

    const due = plays
      .filter(p => p.finished && p.finishedAt)
      .map(p => ({ p, age: now - new Date(p.finishedAt).getTime() }))
      .filter(({ age }) => age >= MIN_AGE_MS && age <= MAX_AGE_MS)
      .sort((a, b) => a.age - b.age)          // freshest night first
      .map(({ p }) => p);

    for (const p of due) {
      if (out.filter(o => o.generated).length >= MAX_PER_RUN) break;
      if (await getArticle(p.eventId)) continue;   // already published
      try {
        const r = await generateRecapArticle(p.eventId);
        out.push({
          eventId: p.eventId,
          generated: !!r.ok,
          engine: r.engine || null,
          reason: r.reason || null,
        });
      } catch (e) {
        out.push({ eventId: p.eventId, generated: false, error: String(e.message || e) });
      }
    }

    if (out.length) console.log('[recap-article-cron]', JSON.stringify(out));
  } catch (e) {
    console.error('[recap-article-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/5 * * * *' };
