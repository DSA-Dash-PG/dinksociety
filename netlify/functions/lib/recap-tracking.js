// netlify/functions/lib/recap-tracking.js
//
// Engagement tracking for the ladder recap emails: who it reached, who opened
// it, who came back to it, and who clicked through to the write-up.
//
// Resend does the measuring (Open + Click tracking on the domain) and posts
// every event to /api/resend-webhook. This module is the storage underneath.
//
//   ladder-email-events   msg/<messageId>.json        who that email was for
//                         idx/<eventId>/<messageId>   the night's message list
//                         log/<messageId>/<n>.json    one file per webhook event
//
// APPEND-ONLY on purpose. Webhook deliveries arrive concurrently and can be
// retried; a read-modify-write counter would race and double-count. Each event
// is its own immutable file and the totals are computed at read time.
//
// READ THE NUMBERS HONESTLY (getEngagement returns `caveat` saying so):
//   - Opens are soft. Apple Mail Privacy Protection pre-fetches images, so an
//     Apple Mail recipient registers an open whether or not they looked. Clients
//     that block images register nothing. Gmail proxies and caches images, so a
//     genuine re-read often does not fire a second event.
//   - Clicks are hard. Somebody clicked through to the recap. That is the
//     number worth trusting, and the one to judge engagement on.

import { getStore } from '@netlify/blobs';

const STORE = 'ladder-email-events';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

const rand = () => Math.random().toString(36).slice(2, 8);

/** Called right after a send, so a later webhook event can be attributed. */
export async function recordSend({ messageId, eventId, playerId, name, email, category = 'recap' }) {
  if (!messageId) return null;
  const rec = {
    messageId, eventId: eventId || null, playerId: playerId || null,
    name: name || null, email: (email || '').toLowerCase() || null,
    category, sentAt: new Date().toISOString(),
  };
  const s = store();
  await s.setJSON(`msg/${messageId}.json`, rec);
  if (eventId) await s.setJSON(`idx/${eventId}/${messageId}.json`, { playerId: rec.playerId });
  return rec;
}

/** One webhook event. Immutable; never overwrites a previous one. */
export async function recordEvent({ messageId, type, at, url, to }) {
  if (!messageId || !type) return null;
  const rec = { messageId, type, at: at || new Date().toISOString(), url: url || null, to: to || null };
  await store().setJSON(`log/${messageId}/${Date.now()}-${rand()}.json`, rec);
  return rec;
}

/** The message → recipient record, or null if we never saw that send. */
export async function getMessage(messageId) {
  if (!messageId) return null;
  return store().get(`msg/${messageId}.json`, { type: 'json' }).catch(() => null);
}

async function eventsFor(s, messageId) {
  const { blobs } = await s.list({ prefix: `log/${messageId}/` }).catch(() => ({ blobs: [] }));
  const recs = await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)));
  return recs.filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/**
 * Per-player engagement for one ladder night.
 * @returns {Promise<{eventId, players:[], totals:{}, caveat:string}>}
 */
export async function getEngagement(eventId) {
  const s = store();
  const { blobs } = await s.list({ prefix: `idx/${eventId}/` }).catch(() => ({ blobs: [] }));
  const messageIds = blobs.map(b => b.key.split('/').pop().replace(/\.json$/, ''));

  const players = [];
  for (const mid of messageIds) {
    const [msg, evts] = await Promise.all([getMessage(mid), eventsFor(s, mid)]);
    if (!msg) continue;
    const byType = t => evts.filter(e => e.type === t);
    const opens = byType('opened');
    const clicks = byType('clicked');
    players.push({
      playerId: msg.playerId,
      name: msg.name,
      email: msg.email,
      messageId: mid,
      sentAt: msg.sentAt,
      delivered: byType('delivered').length > 0,
      bounced: byType('bounced').length > 0,
      complained: byType('complained').length > 0,
      opens: opens.length,
      firstOpenAt: opens[0]?.at || null,
      lastOpenAt: opens.length ? opens[opens.length - 1].at : null,
      clicks: clicks.map(c => ({ at: c.at, url: c.url })),
      clickCount: clicks.length,
      // The one that answers "did they read the write-up".
      openedArticle: clicks.some(c => /\/ladders\/recaps\//.test(c.url || '')),
    });
  }

  players.sort((a, b) => (b.clickCount - a.clickCount) || (b.opens - a.opens)
    || String(a.name || '').localeCompare(String(b.name || '')));

  const totals = {
    sent: players.length,
    delivered: players.filter(p => p.delivered).length,
    opened: players.filter(p => p.opens > 0).length,
    reopened: players.filter(p => p.opens > 1).length,
    clicked: players.filter(p => p.clickCount > 0).length,
    readArticle: players.filter(p => p.openedArticle).length,
    bounced: players.filter(p => p.bounced).length,
  };

  return {
    eventId,
    players,
    totals,
    caveat: 'Clicks are reliable. Opens are approximate: Apple Mail pre-fetches images '
      + '(counts an open nobody made), image blocking hides real opens, and Gmail caches '
      + 'images so a genuine re-read often does not register.',
  };
}
