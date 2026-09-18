// netlify/functions/potw-email-cron.js
// Netlify SCHEDULED function — silently DRAFTS the weekly SuprDupr Player of the
// Week congratulation emails into the admin "Player of the Week" section. Nothing
// is sent to a member: Richard reviews each draft and taps Send in the admin
// panel (which delivers from dink@dinksociety.app with replies routed there).
//
// Runs FRIDAYS 14:45 UTC (~7:45am Pacific), the morning after Season 2's
// Thursday game night, so results are finalized and standings have settled.
// (Season 1 played Mondays and this ran Wednesdays.) Operates on whichever
// season is LIVE — resolved from the season records, not hardcoded — and
// no-ops when the latest week was already prepared.

import { prepareWeeklyPotwApproval, getPotwSettings, sendAllPending } from './lib/potw-email.js';
import { liveCircuit } from './lib/current-season.js';

export default async () => {
  try {
    const circuit = await liveCircuit();
    // notify:false → just stage the drafts; the admin panel is the send surface.
    const result = await prepareWeeklyPotwApproval(circuit, { notify: false });
    console.log('[potw-email-cron]', JSON.stringify(result));

    // If the admin has flipped auto-send on, deliver this week's drafts now.
    // Otherwise they wait in the panel for a manual Send.
    if (result.ok && result.week != null) {
      const { autoSend } = await getPotwSettings();
      if (autoSend) {
        const sent = await sendAllPending(circuit, result.week, 'auto-send');
        console.log('[potw-email-cron] auto-send', JSON.stringify(sent));
      }
    }
  } catch (e) {
    console.error('[potw-email-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '45 14 * * 5' };
