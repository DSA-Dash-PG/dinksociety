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

import { prepareWeeklyPotwApproval, getPotwSettings, sendAllPending, officialWeeks } from './lib/potw-email.js';
import { liveCircuit } from './lib/current-season.js';

export default async () => {
  try {
    const circuit = await liveCircuit();
    // Draft every OFFICIAL week that hasn't been prepared yet, newest first.
    // Usually that's one week; after a rain-out two weeks can finalize on the
    // same night (the carried-over one and the regular one), and the older
    // week must not be skipped just because a newer one exists. A week with
    // games still to play is never drafted (lib/potw-email.js fetchLatestWinners).
    // notify:false → just stage the drafts; the admin panel is the send surface.
    const weeks = await officialWeeks(circuit);
    const { autoSend } = await getPotwSettings();
    for (const week of weeks) {
      const result = await prepareWeeklyPotwApproval(circuit, { notify: false, week });
      console.log('[potw-email-cron]', JSON.stringify(result));
      if (result.reason === 'already-prepared') break; // everything older is done too

      // If the admin has flipped auto-send on, deliver this week's drafts now.
      // Otherwise they wait in the panel for a manual Send.
      if (result.ok && result.week != null && autoSend) {
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
