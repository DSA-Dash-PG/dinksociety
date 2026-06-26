// netlify/functions/admin-ladder-recap.js
// Admin review + send for a ladder-night recap. Admin session required.
//
//   GET  ?event=<id>                       → the saved draft (or { recap:null })
//   POST ?event=<id> { action:'generate', force? } → (re)draft with Claude
//   POST ?event=<id> { action:'send' }     → email every recipient, mark sent
//
// Drafting/sending are separate so AI copy is never emailed without review,
// mirroring The Drop and the POTW mailer. Sends from dink@dinksociety.app.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getRecap, markRecapSent, updateRecapDraft } from './lib/ladder-recap.js';
import { generateLadderRecapDraft } from './lib/ladder-recap-generate.js';
import { renderLadderRecapEmail } from './lib/ladder-recap-email.js';
import { sendEmail } from './lib/email.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}
function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL')) || process.env.SITE_URL || 'https://dinksociety.app';
}

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);

  if (req.method === 'GET') {
    const rec = await getRecap(eventId);
    return json({ recap: rec || null });
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));

    if (body.action === 'generate') {
      try {
        // engine 'basic' = no API (templated). Default tries Claude, then falls
        // back to basic on any API error, so this endpoint never hard-fails.
        const r = await generateLadderRecapDraft(eventId, { force: !!body.force, engine: body.engine });
        if (!r.ok) return json({ error: r.reason || 'Could not generate', skipped: true }, 409);
        return json({ ok: true, recap: r.record, engine: r.engine });
      } catch (e) {
        return json({ error: String(e.message || e) }, 502);
      }
    }

    // Save hand-edited prose (title / dek / article / season note) into the
    // draft — lets the organizer paste a custom write-up before sending.
    if (body.action === 'save-draft') {
      const rec = await updateRecapDraft(eventId, { recap: body.recap || {}, players: body.players || null });
      if (!rec) return json({ error: 'No draft to edit — generate one first.' }, 409);
      return json({ ok: true, recap: rec });
    }

    if (body.action === 'send') {
      const rec = await getRecap(eventId);
      if (!rec || !rec.recap) return json({ error: 'No draft to send — generate one first.' }, 409);
      const url = siteUrl();
      const recipients = rec.recipients || [];
      if (!recipients.length) return json({ error: 'No recipients with an email on this ladder.' }, 409);

      const results = await Promise.allSettled(recipients.map(rcpt => {
        const pr = (rec.players && rec.players[rcpt.playerId]) || { name: rcpt.name, rank: null, count: rec.recap.podium?.length || 0, w: 0, l: 0, diff: 0, delta: null, story: [] };
        const html = renderLadderRecapEmail(pr, rec.recap, rec.event || { name: 'Ladder', date: null }, url);
        return sendEmail({
          to: rcpt.email,
          subject: `Your ladder recap — ${rec.event?.name || 'Dink Society'}`,
          html,
        });
      }));
      const sent = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - sent;
      await markRecapSent(eventId, sent);
      return json({ ok: true, sent, failed });
    }

    return json({ error: 'unknown action' }, 400);
  }

  return json({ error: 'method not allowed' }, 405);
};

export const config = { path: '/.netlify/functions/admin-ladder-recap' };
