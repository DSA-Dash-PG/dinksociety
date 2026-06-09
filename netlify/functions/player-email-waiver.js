// netlify/functions/player-email-waiver.js
// Authed. Emails a copy of the active waiver(s) to the signed-in player's own
// address. Body { waiverId? } — omit to send all active waivers.

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { getActiveWaivers } from './lib/waiver.js';
import { sendEmail, renderWaiverCopy, waiverLooksHtml, sanitizeWaiverHtml } from './lib/email.js';

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const { player } = ctx;

  const to = player.email || null;
  if (!to) return json({ error: 'No email on file for your account.' }, 400);

  let body = {};
  try { body = await req.json(); } catch { /* optional */ }

  let waivers = await getActiveWaivers();
  if (body.waiverId) waivers = waivers.filter(w => w.id === body.waiverId);
  if (!waivers.length) return json({ error: 'No waiver text is available to send.' }, 409);

  // Combine into one email (each waiver titled). If any waiver carries rich
  // text, build an HTML body (titles as headings) so formatting survives;
  // otherwise keep the plain-text join (renderWaiverCopy pre-wraps it).
  const anyHtml = waivers.some(w => waiverLooksHtml(w.text));
  const combined = anyHtml
    ? waivers.map(w =>
        `<h2 style="font-size:17px;font-weight:800;color:#f5f5f5;margin:0 0 10px;">${escHtml(w.title)}</h2>` +
        (waiverLooksHtml(w.text) ? sanitizeWaiverHtml(w.text) : `<div style="white-space:pre-wrap;">${escHtml(w.text)}</div>`)
      ).join('<hr style="border:none;border-top:1px solid #2a2a2a;margin:28px 0;">')
    : waivers.map(w => `${w.title}\n\n${w.text}`).join('\n\n──────────\n\n');
  const subject = waivers.length === 1
    ? `${waivers[0].title} — The Dink Society`
    : `Your Dink Society waivers (${waivers.length})`;

  try {
    await sendEmail({
      to,
      subject,
      html: renderWaiverCopy({
        title: waivers.length === 1 ? waivers[0].title : 'Your waivers',
        text: combined,
        playerName: player.name || null,
      }),
    });
    return json({ ok: true, sentTo: to, count: waivers.length });
  } catch (e) {
    console.error('player-email-waiver send failed:', e);
    return json({ error: 'Could not send the email right now. Please try again.' }, 502);
  }
};

export const config = { path: '/.netlify/functions/player-email-waiver' };
