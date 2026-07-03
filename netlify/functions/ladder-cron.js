// netlify/functions/ladder-cron.js
// Netlify SCHEDULED function — runs every 5 minutes to manage waitlist holds.
//
// For each ladder with an outstanding promoted claim (the next-in-line who has
// a 30-minute window to take an opened spot):
//   • ~5 min before the deadline → send a last-chance NUDGE (once).
//   • past the deadline → expire the claim, promote the next person, and email
//     them the freshly opened spot (a new 30-min window).
//
// Everything here is idempotent-ish: nudgedAt guards the nudge, and an expired
// claim is removed before the next is promoted, so a re-run can't double-act.

import {
  listEvents, getSignups, setSignups, promoteHead, expireClaim,
  nudgeDue, minutesLeft, HOLD_MS,
} from './lib/ladder.js';
import { createLadderToken } from './lib/ladder-token.js';
import { claimUrl, dateLineOf, siteUrl, venmoPayLink } from './lib/ladder-notify.js';
import { sendEmail, renderLadderNudge, renderLadderSpotOpened, renderLadderConfirmed, renderLadderFcfsOpen, renderLadderPayReminder } from './lib/email.js';

// Unpaid-spot reminders: first goes out 1h after signup, then once a day until
// the player pays or the event passes. No auto-drop — the organizer removes.
const PAY_REMIND_FIRST_MS = 60 * 60 * 1000;
const PAY_REMIND_EVERY_MS = 24 * 60 * 60 * 1000;

// Coarse "is this event already over?" — stop reminding once the day has passed.
function eventPast(ev, now) {
  if (!ev?.date) return false;
  const end = Date.parse(`${ev.date}T23:59:59`);
  return Number.isFinite(end) && end < now;
}

export default async () => {
  const now = Date.now();
  let nudged = 0, expired = 0, promoted = 0, payReminders = 0;

  let events = [];
  try { events = await listEvents(); } catch (e) { console.error('[ladder-cron] listEvents failed:', e); return new Response('ok'); }

  for (const ev of events) {
    if (ev.status === 'final' || ev.status === 'cancelled') continue;
    let rec;
    try { rec = await getSignups(ev.id); } catch { continue; }

    let changed = false;

    // ── Unpaid-spot reminders (independent of the waitlist-claim flow) ──
    if (!eventPast(ev, now) && Array.isArray(rec.roster)) {
      const pay = venmoPayLink(ev);
      const payUrl = `${siteUrl()}/ladders?event=${encodeURIComponent(ev.id)}`;
      for (const entry of rec.roster) {
        // Only genuinely unpaid card/unchosen spots — never venmo_pending (they
        // say they've paid; the organizer confirms that separately) or paid.
        if (entry.paymentStatus !== 'pending' || !entry.email) continue;
        const signed = entry.signedUpAt ? Date.parse(entry.signedUpAt) : null;
        if (!signed) continue;
        const last = entry.lastPayReminderAt ? Date.parse(entry.lastPayReminderAt) : null;
        const due = last ? (now - last) >= PAY_REMIND_EVERY_MS : (now - signed) >= PAY_REMIND_FIRST_MS;
        if (!due) continue;
        try {
          await sendEmail({
            to: entry.email,
            subject: `Your spot isn't locked yet — ${ev.name}`,
            html: renderLadderPayReminder({
              playerName: entry.name, eventName: ev.name, dateLine: dateLineOf(ev),
              venmoHandle: pay?.venmoHandle, venmoUrl: pay?.venmoUrl,
              venmoAmountLabel: pay?.venmoAmountLabel, venmoNote: pay?.venmoNote,
              payUrl,
            }),
          });
          entry.lastPayReminderAt = new Date(now).toISOString();
          changed = true; payReminders++;
        } catch (e) { console.warn('[ladder-cron] pay reminder failed:', e?.message || e); }
      }
    }

    // ── Waitlist priority-claim flow (only when a claim is outstanding) ──
    if (rec.pendingClaim) {
    const pc = rec.pendingClaim;

    // 1) last-chance nudge (within the final lead window, not yet nudged)
    if (nudgeDue(pc, now)) {
      try {
        const token = await createLadderToken({
          type: 'claim', eventId: ev.id, playerId: pc.playerId, email: pc.email,
          ttlMs: new Date(pc.claimDeadline).getTime() - now,
        });
        await sendEmail({
          to: pc.email,
          subject: `⏳ ${minutesLeft(pc, now)} min left — claim your spot for ${ev.name}`,
          html: renderLadderNudge({ playerName: pc.name, eventName: ev.name, minutesLeft: minutesLeft(pc, now), claimUrl: claimUrl(token) }),
        });
        pc.nudgedAt = new Date(now).toISOString();
        changed = true; nudged++;
      } catch (e) { console.warn('[ladder-cron] nudge failed:', e?.message || e); }
    }

    // 2) expire an overdue claim, then promote the next person
    const gone = expireClaim(rec, now);
    if (gone) {
      changed = true; expired++;
      const next = promoteHead(rec, ev, now);
      if (next && next.fcfs) {
        // inside 24h → first-come-first-serve: leave the spot open, blast the waitlist
        promoted++;
        try {
          const openUrl = `${siteUrl()}/ladders?event=${encodeURIComponent(ev.id)}`;
          const html = renderLadderFcfsOpen({ eventName: ev.name, dateLine: dateLineOf(ev), openUrl });
          await Promise.allSettled((rec.waitlist || []).map(w => w.email).filter(Boolean)
            .map(to => sendEmail({ to, subject: `Spot open (first come, first served) — ${ev.name}`, html })));
        } catch (e) { console.warn('[ladder-cron] fcfs blast failed:', e?.message || e); }
      } else if (next) {
        promoted++;
        try {
          if (next.autoClaimed) {
            await sendEmail({
              to: next.email,
              subject: `You're in — a spot opened for ${ev.name}`,
              html: renderLadderConfirmed({ playerName: next.name, eventName: ev.name, dateLine: dateLineOf(ev) }),
            });
          } else {
            const token = await createLadderToken({ type: 'claim', eventId: ev.id, playerId: next.playerId, email: next.email, ttlMs: HOLD_MS });
            await sendEmail({
              to: next.email,
              subject: `A spot opened for ${ev.name}`,
              html: renderLadderSpotOpened({ playerName: next.name, eventName: ev.name, dateLine: dateLineOf(ev), minutesLeft: 30, claimUrl: claimUrl(token) }),
            });
          }
        } catch (e) { console.warn('[ladder-cron] promote email failed:', e?.message || e); }
      }
    }
    } // end if (rec.pendingClaim)

    if (changed) { try { await setSignups(rec); } catch (e) { console.error('[ladder-cron] setSignups failed:', e); } }
  }

  console.log(`[ladder-cron] nudged=${nudged} expired=${expired} promoted=${promoted} payReminders=${payReminders}`);
  return new Response('ok');
};

export const config = { schedule: '*/5 * * * *' };
