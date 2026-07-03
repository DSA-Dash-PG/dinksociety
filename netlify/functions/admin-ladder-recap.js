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
import { sendNotify } from './lib/notify-prefs.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}
function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL')) || process.env.SITE_URL || 'https://dinksociety.app';
}

// Render + send one recipient's recap. Returns the sendNotify result
// ({ skipped:true } for a recap opt-out). Shared by the bulk send + resend-one.
function sendRecapTo(rcpt, rec, url) {
  const pr = (rec.players && rec.players[rcpt.playerId]) || { name: rcpt.name, rank: null, count: rec.recap.podium?.length || 0, w: 0, l: 0, diff: 0, delta: null, story: [] };
  const html = renderLadderRecapEmail(pr, rec.recap, rec.event || { name: 'Ladder', date: null }, url);
  return sendNotify({ to: rcpt.email, category: 'recap', subject: `Your ladder recap — ${rec.event?.name || 'Dink Society'}`, html });
}

// Send in small batches so we stay under Resend's 10-requests/second limit
// (firing all recipients at once is what was bouncing sends as "Too many
// requests"). Results come back in the same order as `items`.
async function sendInBatches(items, worker, { size = 5, gapMs = 1100 } = {}) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    out.push(...await Promise.allSettled(batch.map(worker)));
    if (i + size < items.length) await new Promise(r => setTimeout(r, gapMs));
  }
  return out;
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

      const results = await sendInBatches(recipients, rcpt => sendRecapTo(rcpt, rec, url));

      // Classify each recipient so the panel can show WHO didn't get the email,
      // and split genuine send failures from opt-outs (recap unsubscribes come
      // back as { skipped:true } and must not be mistaken for delivery errors).
      const optedOut = [];
      const errored = [];
      results.forEach((r, i) => {
        const rcpt = recipients[i];
        const who = { playerId: rcpt.playerId || null, name: rcpt.name || rcpt.email, email: rcpt.email };
        if (r.status === 'fulfilled' && r.value && r.value.skipped) {
          optedOut.push(who);
        } else if (r.status === 'rejected') {
          errored.push({ ...who, reason: String((r.reason && r.reason.message) || r.reason || 'send failed') });
        }
      });
      const sent = results.length - optedOut.length - errored.length;
      await markRecapSent(eventId, sent);
      // `failed` kept for backward compat = anyone who didn't receive it.
      return json({ ok: true, sent, failed: optedOut.length + errored.length, optedOut, errored });
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
        const r = await sendRecapTo(rcpt, rec, siteUrl());
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
