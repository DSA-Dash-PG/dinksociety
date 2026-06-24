// netlify/functions/potw-email-cron.js
// Netlify SCHEDULED function — silently DRAFTS the weekly K'CHN Player of the
// Week congratulation emails into the admin "Player of the Week" section. Nothing
// is sent to a member: Richard reviews each draft and taps Send in the admin
// panel (which delivers from dink@dinksociety.app with replies routed there).
//
// Runs WEDNESDAYS 14:45 UTC (~7:45am Pacific), a day after game night so all
// Monday-night results are finalized and standings have settled. Operates on the
// live circuit 'I' only; no-ops when the latest week was already prepared.

import { prepareWeeklyPotwApproval } from './lib/potw-email.js';

export default async () => {
  try {
    // notify:false → just stage the drafts; the admin panel is the send surface.
    const result = await prepareWeeklyPotwApproval('I', { notify: false });
    console.log('[potw-email-cron]', JSON.stringify(result));
  } catch (e) {
    console.error('[potw-email-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '45 14 * * 3' };
