// netlify/functions/recap-article-cron.js
//
// Netlify SCHEDULED function — the whole post-night pipeline, hands off:
//
//   1. publish the full recap article at /ladders/recaps/<eventId>
//   2. draft the per-player recap email from the same night's numbers
//   3. email it to everyone on the roster, with the night's photos and a
//      button through to the article
//
// Fires about ten minutes after a night is marked finished. Runs every 5
// minutes and is a cheap no-op when nothing is due: the only work on an idle
// tick is one blob list of the play records.
//
// Why a 5-minute poll and not an exact 10-minute timer: Netlify schedules are
// cron, not one-shot timers, and the night "finishes" inside another request
// (the scorer tapping Finish), so there is nothing to hang a timer on. A night
// therefore publishes 10–15 minutes after it is marked finished.
//
// THIS SENDS EMAIL WITHOUT A HUMAN LOOK. That is deliberate (Richard, 2026-09-11:
// "the scheduled writeups will be the way we do it and it should push the write
// ups to the players once its done"), and it is the reason lib/ladder-recap-basic.js
// is held to "never say something the numbers don't support" — nobody is going to
// catch a bad line before fifteen people read it. Two guards remain:
//   - the article must publish first, or nothing is sent;
//   - sendRecapToAll refuses a night already marked sent, so a retry can't
//     double-mail anyone.
// To go back to review-before-send, set AUTO_SEND to false: the article still
// publishes and the draft still waits in the admin Recaps panel.

import { listPlay } from './lib/ladder-play.js';
import { getArticle } from './lib/recap-article-store.js';
import { generateRecapArticle } from './lib/ladder-recap-article.js';
import { generateLadderRecapDraft } from './lib/ladder-recap-generate.js';
import { sendRecapToAll } from './lib/ladder-recap-send.js';
import { getRecap } from './lib/ladder-recap.js';

const AUTO_SEND = true;
const MIN_AGE_MS = 10 * 60 * 1000;        // the ten minutes after the night ends
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // don't trawl the archive on every tick
const MAX_PER_RUN = 2;                    // each night can mean ~15 emails

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

    let done = 0;
    for (const p of due) {
      if (done >= MAX_PER_RUN) break;
      if (await getArticle(p.eventId)) continue;   // already published

      const step = { eventId: p.eventId };
      try {
        const article = await generateRecapArticle(p.eventId);
        step.article = article.ok ? 'published' : (article.reason || 'skipped');
        if (!article.ok) { out.push(step); continue; }
        done++;

        if (!AUTO_SEND) { step.email = 'held for review'; out.push(step); continue; }

        // Draft first (no-op if one already exists and hasn't been sent), then send.
        const existing = await getRecap(p.eventId);
        if (!existing) {
          const draft = await generateLadderRecapDraft(p.eventId, {});
          step.draft = draft.ok ? 'drafted' : (draft.reason || 'not drafted');
          if (!draft.ok) { out.push(step); continue; }
        } else {
          step.draft = existing.status === 'sent' ? 'already sent' : 'existing draft';
        }

        const sent = await sendRecapToAll(p.eventId);
        step.email = sent.ok
          ? `sent ${sent.sent}${sent.optedOut.length ? `, ${sent.optedOut.length} opted out` : ''}${sent.errored.length ? `, ${sent.errored.length} failed` : ''}`
          : sent.error;
        if (sent.ok && sent.errored.length) step.errored = sent.errored;
      } catch (e) {
        step.error = String(e.message || e);
      }
      out.push(step);
    }

    if (out.length) console.log('[recap-article-cron]', JSON.stringify(out));
  } catch (e) {
    console.error('[recap-article-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/5 * * * *' };
