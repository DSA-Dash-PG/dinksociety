// netlify/functions/ladder-recap-cron.js
// Netlify SCHEDULED function — drafts a ladder-night recap ~15 minutes after a
// night is finished. Runs every 15 minutes; cheap no-op when nothing is due.
// NEVER sends — the draft waits in the admin "Recaps" panel for review.

import { listPlay } from './lib/ladder-play.js';
import { getRecap } from './lib/ladder-recap.js';
import { generateLadderRecapDraft } from './lib/ladder-recap-generate.js';

const MIN_AGE_MS = 15 * 60 * 1000;        // wait 15 min after finish
const MAX_AGE_MS = 6 * 60 * 60 * 1000;    // don't auto-draft nights older than 6h

export default async () => {
  const out = [];
  try {
    const plays = await listPlay();
    const now = Date.now();
    for (const p of plays) {
      if (!p.finished || !p.finishedAt) continue;
      const age = now - new Date(p.finishedAt).getTime();
      if (age < MIN_AGE_MS || age > MAX_AGE_MS) continue;
      const existing = await getRecap(p.eventId);
      if (existing) continue; // already drafted (or sent) — leave it alone
      try {
        const r = await generateLadderRecapDraft(p.eventId, {});
        out.push({ eventId: p.eventId, ok: r.ok, reason: r.reason || null });
      } catch (e) {
        out.push({ eventId: p.eventId, ok: false, error: String(e.message || e) });
      }
    }
    console.log('[ladder-recap-cron]', JSON.stringify(out));
  } catch (e) {
    console.error('[ladder-recap-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/15 * * * *' };
