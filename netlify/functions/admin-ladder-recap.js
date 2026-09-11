// netlify/functions/admin-ladder-recap.js
// Admin review + send for a ladder-night recap. Admin session required.
//
//   GET  ?event=<id>                       → the saved draft (or { recap:null })
//   POST ?event=<id> { action:'generate', force? } → (re)draft with Claude
//   POST ?event=<id> { action:'send' }     → email every recipient, mark sent
//
// Drafting/sending are separate so AI copy is never emailed without review,
// mirroring The Drop and the POTW mailer. Sends from dink@dinksociety.app.

import { requireLadderOwner, orgErr } from './lib/organizer-auth.js';
import { getRecap, markRecapSent, updateRecapDraft } from './lib/ladder-recap.js';
import { generateLadderRecapDraft } from './lib/ladder-recap-generate.js';
import { sendRecapToAll, sendRecapTo, recapPhotoIds } from './lib/ladder-recap-send.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}
function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL')) || process.env.SITE_URL || 'https://dinksociety.app';
}

export default async (req) => {
  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);

  // Admin, or the organizer who owns this ladder, may draft/send its recap.
  const auth = await requireLadderOwner(req, eventId);
  if (!auth.ok) return orgErr(auth);

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
      const r = await sendRecapToAll(eventId, { url: siteUrl() });
      if (!r.ok) return json({ error: r.error }, 409);
      // `failed` kept for backward compat = anyone who didn't receive it.
      return json({
        ok: true, sent: r.sent, failed: r.optedOut.length + r.errored.length,
        optedOut: r.optedOut, errored: r.errored,
      });
    }

    // Resend the recap to ONE recipient — used by the per-player "Resend" button
    // when a bulk send bounced someone (rate limit, transient error, etc.).
    if (body.action === 'send-one') {
      const rec = await getRecap(eventId);
      if (!rec || !rec.recap) return json({ error: 'No draft to send — generate one first.' }, 409);
      const norm = String(body.email || '').trim().toLowerCase();
      const rcpt = (rec.recipients || []).find(r =>
        (body.playerId && r.playerId === body.playerId) || (norm && String(r.email || '').toLowerCase() === norm));
      if (!rcpt) return json({ error: 'That player is not on this ladder’s send list.' }, 404);
      if (!rcpt.email) return json({ error: 'No email on file for this player.' }, 400);
      try {
        const r = await sendRecapTo(rcpt, rec, siteUrl(), await recapPhotoIds(eventId));
        if (r && r.skipped) return json({ ok: true, skipped: true, name: rcpt.name, email: rcpt.email });
        return json({ ok: true, sent: 1, name: rcpt.name, email: rcpt.email });
      } catch (e) {
        return json({ error: String((e && e.message) || e || 'send failed'), name: rcpt.name, email: rcpt.email }, 502);
      }
    }

    return json({ error: 'unknown action' }, 400);
  }

  return json({ error: 'method not allowed' }, 405);
};

export const config = { path: '/.netlify/functions/admin-ladder-recap' };
