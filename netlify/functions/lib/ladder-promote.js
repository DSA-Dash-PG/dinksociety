// netlify/functions/lib/ladder-promote.js
// Shared "a spot opened → promote the next person and email them" logic, used by
// both ladder-signup.js (player cancel) and admin-ladder-manage.js (admin remove
// / decline). Honors the 30-min hold, auto-claim, and the final-24h FCFS blast.
// Returns { opened: 'fcfs' | <name> | null }. Caller persists the signups record.

import { promoteHead, HOLD_MS } from './ladder.js';
import { createLadderToken } from './ladder-token.js';
import { claimUrl, dateLineOf, siteUrl } from './ladder-notify.js';
import { sendEmail, renderLadderSpotOpened, renderLadderConfirmed, renderLadderFcfsOpen } from './email.js';
import { sendNotify } from './notify-prefs.js';

export async function promoteAndNotify(event, signups) {
  const next = promoteHead(signups, event);
  if (!next) return { opened: null };

  try {
    if (next.fcfs) {
      const openUrl = `${siteUrl()}/ladders?event=${encodeURIComponent(event.id)}`;
      const html = renderLadderFcfsOpen({ eventName: event.name, dateLine: dateLineOf(event), openUrl });
      await Promise.allSettled((signups.waitlist || []).map(w => w.email).filter(Boolean)
        .map(to => sendNotify({ to, category: 'waitlist', subject: `Spot open (first come, first served) — ${event.name}`, html })));
      return { opened: 'fcfs' };
    }
    if (next.autoClaimed) {
      await sendEmail({
        to: next.email,
        subject: `You're in — a spot opened for ${event.name}`,
        html: renderLadderConfirmed({ playerName: next.name, eventName: event.name, dateLine: dateLineOf(event) }),
      });
      return { opened: next.name };
    }
    const tok = await createLadderToken({ type: 'claim', eventId: event.id, playerId: next.playerId, email: next.email, ttlMs: HOLD_MS });
    await sendNotify({
      to: next.email,
      category: 'waitlist',
      subject: `A spot opened for ${event.name}`,
      html: renderLadderSpotOpened({ playerName: next.name, eventName: event.name, dateLine: dateLineOf(event), minutesLeft: 30, claimUrl: claimUrl(tok) }),
    });
    return { opened: next.name };
  } catch (e) {
    console.warn('[ladder-promote] notify failed:', e?.message || e);
    return { opened: next.fcfs ? 'fcfs' : next.name };
  }
}
