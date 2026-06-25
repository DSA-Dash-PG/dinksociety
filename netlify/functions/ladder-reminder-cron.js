// netlify/functions/ladder-reminder-cron.js
// Netlify SCHEDULED function — sends the automatic ladder roster reminders.
//
// Runs every 15 minutes and fires any due reminder for upcoming ladders:
//   · 2 days before start
//   · 5:00 AM on the day of the event
//   · 3 hours before start
// Idempotent (one marker per event+kind), so each reminder goes out once even
// though the cron runs frequently. Manual pushes (admin-ladder-remind) set the
// same marker, so they won't be duplicated here.

import { runDueReminders } from './lib/ladder-reminders.js';

export default async () => {
  try {
    const out = await runDueReminders('I');
    if (out.length) console.log('[ladder-reminder-cron]', JSON.stringify(out));
  } catch (e) {
    console.error('[ladder-reminder-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/15 * * * *' };
