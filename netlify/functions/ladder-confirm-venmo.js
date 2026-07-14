// netlify/functions/ladder-confirm-venmo.js
// One-tap organizer action from the Venmo-claim email. The token carries its own
// auth (signed, single-use) — no login. GET so it works straight from an inbox.
//
//   GET ?t=<token>   token.type 'venmo-confirm' | 'venmo-decline'

import { normalizeEmail } from './lib/identity.js';
import { getEvent, getSignups, setSignups, removeFromRoster, promoteHead } from './lib/ladder.js';
import { consumeLadderToken } from './lib/ladder-token.js';
import { createLadderToken } from './lib/ladder-token.js';
import { claimUrl, dateLineOf, resultPage, cancelLinkFor } from './lib/ladder-notify.js';
import { sendEmail, renderLadderConfirmed, renderLadderSpotOpened } from './lib/email.js';
import { HOLD_MS } from './lib/ladder.js';

export default async (req) => {
  const token = new URL(req.url).searchParams.get('t');
  const rec = await consumeLadderToken(token);
  if (!rec || (rec.type !== 'venmo-confirm' && rec.type !== 'venmo-decline')) {
    return resultPage('Link expired', 'This confirmation link is no longer valid — it may have already been used.', '#ff5c47');
  }

  const event = await getEvent(rec.eventId);
  if (!event) return resultPage('Not found', 'That ladder no longer exists.', '#ff5c47');
  const signups = await getSignups(rec.eventId);
  const norm = normalizeEmail(rec.email);

  if (rec.type === 'venmo-confirm') {
    const entry = signups.roster.find(p => normalizeEmail(p.email) === norm);
    if (!entry) return resultPage('Already handled', 'That player is no longer pending on this ladder.', '#f0c040');
    entry.paymentStatus = 'paid';
    entry.paymentMethod = 'venmo';
    entry.heldUntil = null;
    await setSignups(signups);
    await sendEmail({
      to: entry.email,
      subject: `You're in — ${event.name}`,
      html: renderLadderConfirmed({ playerName: entry.name, eventName: event.name, dateLine: dateLineOf(event), cancelUrl: await cancelLinkFor(event, { playerId: entry.playerId, email: entry.email }) }),
    }).catch(() => {});
    return resultPage('Confirmed ✓', `${escapeName(entry.name)} is in for ${escapeName(event.name)}. We emailed them the good news — nothing else to do.`);
  }

  // decline → release the spot and promote the next person
  const removed = removeFromRoster(signups, { email: rec.email });
  const next = promoteHead(signups, event);
  await setSignups(signups);
  if (next && !next.autoClaimed) {
    const t = await createLadderToken({ type: 'claim', eventId: event.id, playerId: next.playerId, email: next.email, ttlMs: HOLD_MS });
    await sendEmail({
      to: next.email,
      subject: `A spot opened for ${event.name}`,
      html: renderLadderSpotOpened({ playerName: next.name, eventName: event.name, dateLine: dateLineOf(event), minutesLeft: 30, claimUrl: claimUrl(t) }),
    }).catch(() => {});
  }
  return resultPage('Declined', `${removed ? escapeName(removed.name) + "'s" : 'That'} spot was released${next ? ' and offered to the next person on the waitlist' : ''}.`, '#f0c040');
};

function escapeName(s) { return String(s || '').replace(/[<>&]/g, ''); }

export const config = { path: '/.netlify/functions/ladder-confirm-venmo' };
