// netlify/functions/lib/ladder-recap-send.js
//
// One copy of "email this night's recap to everyone on the roster", shared by
// the admin Send button (admin-ladder-recap.js) and the automatic send that
// follows article publication (recap-article-cron.js).
//
// Every recipient gets their own render: Part 1 is personal, Part 2 and the
// photo strip are shared. Sends go out from dink@dinksociety.app in batches of
// five with a pause between, because firing all of them at once trips Resend's
// 10-requests-per-second limit and bounces the tail of the list.

import { getRecap, markRecapSent } from './ladder-recap.js';
import { renderLadderRecapEmail } from './ladder-recap-email.js';
import { sendNotify } from './notify-prefs.js';
import { listPhotos } from './ladder-photos.js';

export function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.app';
}

const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * That player's note from the draft, or null when we genuinely can't identify
 * them. Tries the canonical id, then the id they signed up under, then an exact
 * name match (which covers a player whose merge hasn't been recorded yet).
 */
export function findPlayerNote(rec, rcpt) {
  const players = rec.players || {};
  if (rcpt.playerId && players[rcpt.playerId]) return players[rcpt.playerId];
  if (rcpt.signupId && players[rcpt.signupId]) return players[rcpt.signupId];
  const want = normName(rcpt.name);
  if (want) {
    for (const p of Object.values(players)) if (normName(p.name) === want) return p;
  }
  return null;
}

/**
 * Render + send one recipient's copy. `{skipped:true}` means a recap opt-out;
 * `{skipped:true, unmatched:true}` means we could not find their stats.
 *
 * There used to be a fallback here that mailed a zeroed record (0-0, no finish,
 * "of 3") when the lookup missed. That is worse than sending nothing: it looks
 * like a real email and tells the player their night did not happen. Three
 * people got one on 2026-09-11. Now an unmatched player is skipped and reported.
 */
export function sendRecapTo(rcpt, rec, url, photoIds) {
  const pr = findPlayerNote(rec, rcpt);
  if (!pr) {
    return Promise.resolve({ skipped: true, unmatched: true, name: rcpt.name, email: rcpt.email });
  }
  const html = renderLadderRecapEmail(
    pr, rec.recap, rec.event || { name: 'Ladder', date: null }, url, photoIds
  );
  return sendNotify({
    to: rcpt.email,
    category: 'recap',
    subject: `Your ladder recap — ${rec.event?.name || 'Dink Society'}`,
    html,
  });
}

async function sendInBatches(items, worker, { size = 5, gapMs = 1100 } = {}) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...await Promise.allSettled(batch.map(worker)));
    if (i + size < items.length) await new Promise(r => setTimeout(r, gapMs));
  }
  return out;
}

/** The night's photo ids, newest album first. Never throws — no photos is fine. */
export async function recapPhotoIds(eventId, limit = 3) {
  try {
    const all = await listPhotos(eventId);
    return (all || []).map(p => p.id).filter(Boolean).slice(0, Math.max(limit, 12));
  } catch {
    return [];
  }
}

/**
 * Send the saved draft to every recipient on it.
 * @returns {Promise<{ok, sent?, optedOut?, errored?, unmatched?, error?}>}
 */
export async function sendRecapToAll(eventId, { url = siteUrl() } = {}) {
  const rec = await getRecap(eventId);
  if (!rec || !rec.recap) return { ok: false, error: 'No draft to send' };
  if (rec.status === 'sent') return { ok: false, error: 'Already sent', alreadySent: true };

  const recipients = rec.recipients || [];
  if (!recipients.length) return { ok: false, error: 'No recipients with an email on this ladder' };

  const photoIds = await recapPhotoIds(eventId);
  const results = await sendInBatches(recipients, r => sendRecapTo(r, rec, url, photoIds));

  // Separate opt-outs from genuine failures so the panel can show who missed it
  // and why — an unsubscribe is not a delivery error.
  const optedOut = [], errored = [], unmatched = [];
  results.forEach((r, i) => {
    const rcpt = recipients[i];
    const who = { playerId: rcpt.playerId || null, name: rcpt.name || rcpt.email, email: rcpt.email };
    if (r.status === 'fulfilled' && r.value && r.value.unmatched) unmatched.push(who);
    else if (r.status === 'fulfilled' && r.value && r.value.skipped) optedOut.push(who);
    else if (r.status === 'rejected') {
      errored.push({ ...who, reason: String((r.reason && r.reason.message) || r.reason || 'send failed') });
    }
  });

  const sent = results.length - optedOut.length - errored.length - unmatched.length;
  await markRecapSent(eventId, sent);
  if (unmatched.length) {
    console.warn('[ladder-recap-send] no stats matched, not mailed:',
      JSON.stringify(unmatched.map(u => u.name)));
  }
  return { ok: true, sent, optedOut, errored, unmatched, photos: photoIds.length };
}
