// netlify/functions/drop-cron.js
// Netlify SCHEDULED function — drafts The Drop after each game night.
//
// Runs Tuesdays 14:30 UTC ≈ 7:30am Pacific (PDT). In standard time (PST) this
// lands at 6:30am — still well after Monday-night results are finalized, so the
// exact minute doesn't matter. The draft waits in the admin composer for review;
// nothing publishes automatically.
//
// Operates on the live circuit 'I' only (the TEST season is never touched, and
// generateDropDraft no-ops when there are no new finalized results).

import { generateDropDraft } from './lib/drop-generate.js';

export default async () => {
  try {
    const result = await generateDropDraft('I', {});
    console.log('[drop-cron]', JSON.stringify(result));
  } catch (e) {
    console.error('[drop-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '30 14 * * 2' };
