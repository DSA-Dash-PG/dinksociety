// netlify/functions/ohana-reminder-cron.js
// Scheduled (hourly). Automatic emails for the private South Bay Ohana page:
//   • day before our match, from 9am PT → reminder to the whole roster
//     (matchup, time, courts, and each player's games if the lineup is set)
//   • day before a bye week, from 9am PT → short "no match for us" note
//   • two days before our match, from 9am PT, if the lineup is still empty →
//     nudge to the managers
// Each send is recorded in league.sent so it only ever goes once, and nothing
// sends after the match has started (no catch-up blasts after an outage).

import { loadLeague, saveLeague, emailReminder, emailLineupNudge } from './lib/ohana.js';
import { isOurs, isByeWeek, laMs, matchDate } from './lib/ohana-core.js';

const DAY = 24 * 60 * 60 * 1000;

/** 9:00am PT, `daysBefore` days before YYYY-MM-DD. */
function nineAmBefore(dateStr, daysBefore) {
  const d = new Date(Date.UTC(...dateStr.split('-').map((n, i) => i === 1 ? +n - 1 : +n)) - daysBefore * DAY);
  return laMs(d.toISOString().slice(0, 10), '9:00 AM');
}

export async function runOhanaReminders(now = Date.now()) {
  const league = await loadLeague();
  league.sent ||= {};
  const done = [];
  for (const wk of league.weeks) {
    const m = wk.matches.find(x => isOurs(league, x));
    if (m) {
      const date = matchDate(wk, m);
      const start = laMs(date, m.time);
      if (now >= start) continue;
      const hasLineup = (m.slots || []).some(s => (s.players || []).some(Boolean));
      const nudgeKey = `nudge:${m.id}:${date}`;
      if (!hasLineup && !league.sent[nudgeKey] && now >= nineAmBefore(date, 2)) {
        league.sent[nudgeKey] = new Date(now).toISOString();
        done.push({ nudge: m.id, ...(await emailLineupNudge(league, wk, m)) });
      }
      const remKey = `remind:${m.id}:${date}`;
      if (!league.sent[remKey] && now >= nineAmBefore(date, 1)) {
        league.sent[remKey] = new Date(now).toISOString();
        done.push({ remind: m.id, ...(await emailReminder(league, wk, m)) });
      }
    } else if (isByeWeek(league, wk)) {
      const key = `bye:${wk.id}`;
      if (!league.sent[key] && now >= nineAmBefore(wk.date, 1) && now < laMs(wk.date, '7:00 PM')) {
        league.sent[key] = new Date(now).toISOString();
        done.push({ bye: wk.id, ...(await emailReminder(league, wk, null)) });
      }
    }
  }
  if (done.length) await saveLeague(league);
  return done;
}

export default async () => {
  try {
    const out = await runOhanaReminders();
    if (out.length) console.log('[ohana-reminder-cron]', JSON.stringify(out));
  } catch (e) {
    console.error('[ohana-reminder-cron] failed:', e);
  }
  return new Response('ok');
};

export const config = { schedule: '5 * * * *' };
