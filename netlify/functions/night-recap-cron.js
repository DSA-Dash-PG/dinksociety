// netlify/functions/night-recap-cron.js
// Netlify SCHEDULED function — the league "morning-after" email (the Receipt).
//
// Every 15 minutes: is there a league night whose matches are all finalized,
// whose morning-after has arrived (7:30 AM Pacific), and that has not been
// mailed? If so, queue it and hand it to night-recap-send-background, which has
// the 15 minutes a 100-player send needs (a scheduled function gets 30 seconds).
//
// Not pinned to a weekday on purpose: league night moves from season to season,
// and a night finalized late simply goes out at the next tick after it settles.
// The rule itself is dueWeek() in lib/night-recap-data.js; the guards against
// double-sending are in lib/night-recap.js. A cheap no-op when nothing is due.
//
// THIS SENDS EMAIL WITHOUT A HUMAN LOOK (Richard, 2026-10-09). Switch it off in
// Admin → Player of the Week → Game-night recap, or preview any player's email
// there first.

import { runDue } from './lib/night-recap.js';

export default async () => {
  try {
    const out = await runDue(new Date());
    if (out.sent || (out.reason && !/waiting|before 7:30|after 8 PM|three days|no finalized|already sent/.test(out.reason))) {
      console.log('[night-recap-cron]', JSON.stringify(out));
    }
  } catch (e) {
    console.error('[night-recap-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/15 * * * *' };
