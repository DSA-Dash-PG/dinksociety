// netlify/functions/availability-reminder-cron.js
// Netlify SCHEDULED function — sends automatic availability reminders.
//
// Runs every 30 minutes. For each upcoming match it emails regular (non-sub)
// rostered players who haven't responded: starting 4 days before the match, then
// once per day (daytime LA) until they confirm or the lineup locks. Idempotent
// (one marker per player per LA calendar day), so it's safe to run frequently and
// alongside manual captain nudges.

import { runDueAvailabilityReminders } from './lib/availability-reminders.js';

export default async () => {
  try {
    const out = await runDueAvailabilityReminders('I');
    if (out.length) console.log('[availability-reminder-cron]', JSON.stringify(out));
  } catch (e) {
    console.error('[availability-reminder-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '*/30 * * * *' };
