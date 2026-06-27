// netlify/functions/ladder-claim.js
// A promoted waitlister claims their held spot from the spot-opened / nudge
// email. Token-authed (signed, single-use), GET so it works from an inbox.
//
//   GET ?t=<token>   token.type 'claim'
//
// Claiming moves them onto the roster as PENDING PAYMENT; they then pay (card or
// Venmo) in the app. If the 30-min window already lapsed, the spot is gone.

import { getEvent, getSignups, setSignups, claimSpot } from './lib/ladder.js';
import { consumeLadderToken } from './lib/ladder-token.js';
import { siteUrl, resultPage } from './lib/ladder-notify.js';

export default async (req) => {
  const token = new URL(req.url).searchParams.get('t');
  const rec = await consumeLadderToken(token);
  if (!rec || rec.type !== 'claim') {
    return resultPage('Link expired', 'This claim link is no longer valid — the spot may have rolled to the next person.', '#ff5c47');
  }

  const event = await getEvent(rec.eventId);
  if (!event) return resultPage('Not found', 'That ladder no longer exists.', '#ff5c47');

  const signups = await getSignups(rec.eventId);
  const ok = claimSpot(signups, { playerId: rec.playerId, email: rec.email });
  if (!ok) {
    return resultPage('Just missed it', 'This spot already rolled to the next person on the waitlist. You\'re still on the list for the next opening.', '#f0c040');
  }
  await setSignups(signups);

  const payUrl = `${siteUrl()}/ladders?event=${encodeURIComponent(event.id)}&claimed=1`;
  return resultPage(
    'Spot claimed',
    `You're on the roster for ${escapeName(event.name)}. Last step — <a href="${payUrl}" style="color:#b8ff2c;font-weight:700">open the app to pay</a> and lock it in.`,
  );
};

function escapeName(s) { return String(s || '').replace(/[<>&]/g, ''); }

export const config = { path: '/.netlify/functions/ladder-claim' };
