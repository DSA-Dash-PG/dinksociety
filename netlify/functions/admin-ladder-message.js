// netlify/functions/admin-ladder-message.js
// Messages to the players of one ladder. Admin session, or the organizer who
// owns the ladder (requireLadderOwner).
//
// GET  /api/admin-ladder-message?eventId=<id>
//   → { messages: [newest first], counts: { roster, waitlist, duprUnverified } }
//     Everything already sent to this ladder, plus how many people each
//     "send to" choice would reach right now.
//
// POST /api/admin-ladder-message
//   Body: { eventId, subject?, message, format?, audience?, kind?, changes? }
//     subject   optional — defaults to the ladder name
//     message   required
//     format    'html' (the rich text editor's innerHTML) or omitted/'text'
//               (plain text: newlines become line breaks, the rest is escaped)
//     audience  { roster?: true, waitlist?: false, only?: 'dupr-unverified' }
//               Defaults to the confirmed roster only, which is what this
//               endpoint always did. `only` narrows to players not yet verified
//               in the DUPR club (admin ladders).
//     kind      'update' when the message announces a change to the ladder
//               (date, time, place, courts); otherwise 'message'
//     changes   the change list the save returned, kept with the log entry
//
// Unlike the marketing blast/announce sends (admin-ladder-blast.js), this is an
// operational message about a ladder someone is actually signed up for, so it
// always delivers and does not respect the optional notify-prefs categories.
// Signed-up players also see it in the player portal (player-ladder-events.js).

import { requireLadderOwner, orgErr } from './lib/organizer-auth.js';
import { getSignups } from './lib/ladder.js';
import { getDirectory, applyDirectoryToSignups } from './lib/player-directory.js';
import {
  sendLadderMessage, listEventMessages, audienceCounts,
  sanitizeMessageHtml, textToHtml, isBlankHtml,
} from './lib/ladder-messages.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

export default async (req) => {
  if (req.method === 'GET') {
    const eventId = new URL(req.url).searchParams.get('eventId');
    if (!eventId) return json({ error: 'eventId required' }, 400);
    const auth = await requireLadderOwner(req, eventId);
    if (!auth.ok) return orgErr(auth);
    const signups = applyDirectoryToSignups(await getSignups(eventId), await getDirectory().catch(() => ({})));
    return json({ messages: await listEventMessages(eventId), counts: audienceCounts(signups) });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const b = await req.json().catch(() => ({}));
  const eventId = b.eventId;
  if (!eventId) return json({ error: 'eventId required' }, 400);
  const auth = await requireLadderOwner(req, eventId);
  if (!auth.ok) return orgErr(auth);
  const event = auth.event;
  if (!event) return json({ error: 'Event not found' }, 404);

  const format = b.format === 'html' ? 'html' : 'text';
  const message = (b.message || '').toString();
  if (format === 'html' ? isBlankHtml(message) : !message.trim()) {
    return json({ error: 'A message is required.' }, 400);
  }

  const a = (b.audience && typeof b.audience === 'object') ? b.audience : {};
  const audience = {
    roster: a.roster !== false,
    waitlist: !!a.waitlist,
    // The DUPR club filter reads verification status, which organizers don't manage.
    ...(a.only === 'dupr-unverified' && auth.role === 'admin' ? { only: 'dupr-unverified' } : {}),
  };
  if (!audience.roster && !audience.waitlist) return json({ error: 'Choose who to send to.' }, 400);

  const res = await sendLadderMessage({
    event,
    subject: (b.subject || '').toString(),
    bodyHtml: format === 'html' ? sanitizeMessageHtml(message) : textToHtml(message),
    audience,
    kind: b.kind === 'update' ? 'update' : 'message',
    changes: Array.isArray(b.changes) ? b.changes.slice(0, 12).map(c => ({
      field: String(c.field || '').slice(0, 30), label: String(c.label || '').slice(0, 40),
      from: String(c.from || '').slice(0, 200), to: String(c.to || '').slice(0, 200),
    })) : null,
    sentBy: auth.email || null,
    role: auth.role,
    // An organizer's players reply to the organizer, not the league inbox.
    replyTo: auth.role === 'organizer' ? auth.email : null,
  });
  return json(res);
};

export const config = { path: '/.netlify/functions/admin-ladder-message' };
