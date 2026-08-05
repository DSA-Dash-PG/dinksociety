// netlify/functions/admin-ladder-message.js
// POST /api/admin-ladder-message  (admin session required)
// Send a custom, free-text message to everyone currently on the CONFIRMED
// ROSTER of one specific ladder (not the waitlist, not past participants —
// see admin-ladder-blast.js for that). This is an operational message about
// a ladder someone is actually signed up for, so — unlike the marketing
// blast/announce sends — it always delivers and does not respect the
// optional notify-prefs unsubscribe categories.
//
// Body: { eventId, subject, message }
//   subject  optional — defaults to the ladder name
//   message  required, plain text (newlines are preserved as line breaks;
//            everything else is HTML-escaped, so it's safe to paste anything)

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getEvent, getSignups } from './lib/ladder.js';
import { sendEmail } from './lib/email.js';
import { dateLineOf, siteUrl } from './lib/ladder-notify.js';
import { normalizeEmail } from './lib/identity.js';
import { getStore } from '@netlify/blobs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function messageFrom() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('LADDER_FROM')) || process.env.LADDER_FROM || 'dink@dinksociety.app';
}
// Plain text → safe HTML: escape, then turn newlines into breaks/paragraphs.
function textToHtml(text) {
  return String(text || '').trim().split(/\n{2,}/).map(block =>
    `<p style="margin:0 0 14px">${esc(block).replace(/\n/g, '<br>')}</p>`
  ).join('');
}

function shell(inner) {
  return `<div style="background:#0e0e0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;max-width:600px;margin:0 auto;padding:36px 26px">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:22px">THE DINK SOCIETY <span style="color:#17d7b0">· LADDER</span></div>
    ${inner}
    <div style="margin-top:30px;padding-top:16px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;line-height:1.6"><b style="color:#8a8a8a;font-weight:700">THE DINK SOCIETY · LADDER</b> · Open play, round-robin nights.</div>
  </div>`;
}

function renderMessage({ name, event, site, subject, bodyHtml }) {
  return shell(`
    <span style="display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#17d7b0;background:rgba(23,215,176,.10);border:1px solid rgba(23,215,176,.30);padding:6px 12px;border-radius:9999px;margin-bottom:14px">✉️ Message from the league</span>
    <h1 style="font-size:24px;font-weight:800;line-height:1.15;margin:0 0 6px">Hey ${esc(firstName(name))},</h1>
    <p style="font-size:13px;color:#8a8a8a;font-weight:700;margin:0 0 22px">About: ${esc(event.name)} · ${esc(dateLineOf(event))}</p>
    <div style="font-size:15px;color:#e7eaee;line-height:1.7;margin:0 0 22px">${bodyHtml}</div>
    <a href="${site}/ladders.html?event=${encodeURIComponent(event.id)}" style="display:inline-block;padding:14px 30px;background-color:#b8ff2c;background-image:linear-gradient(135deg,#c6f24e 0%,#8fe04a 100%);color:#0e0e0e;font-size:14px;font-weight:800;text-decoration:none;border-radius:14px;margin:2px 0">View this ladder →</a>
  `);
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const b = await req.json().catch(() => ({}));
  const eventId = b.eventId;
  const message = (b.message || '').toString().trim();
  if (!eventId) return json({ error: 'eventId required' }, 400);
  if (!message) return json({ error: 'A message is required.' }, 400);

  const event = await getEvent(eventId);
  if (!event) return json({ error: 'Event not found' }, 404);

  const signups = await getSignups(eventId);
  // Roster only — confirmed/registered players, not the waitlist.
  const byEmail = new Map();
  for (const p of (signups.roster || [])) {
    const e = normalizeEmail(p.email);
    if (e && !byEmail.has(e)) byEmail.set(e, p.name || '');
  }
  if (!byEmail.size) return json({ ok: true, sent: 0, recipients: 0, note: 'No one with an email is on the roster yet.' });

  const site = siteUrl();
  const from = messageFrom();
  const subject = (b.subject || '').toString().trim() || `About ${event.name}`;
  const bodyHtml = textToHtml(message);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  let sent = 0, failed = 0;
  for (const [email, name] of byEmail) {
    try {
      await sendEmail({
        to: email,
        from,
        replyTo: from,
        subject: `${subject} — The Dink Society`,
        html: renderMessage({ name, event, site, subject, bodyHtml }),
      });
      sent++;
      await sleep(120);
    } catch (e) {
      console.error('admin-ladder-message send failed:', e);
      failed++;
    }
  }

  // Audit trail — who sent what, to which ladder, when.
  try {
    const id = 'lm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await getStore('ladder-messages').setJSON(`message/${id}.json`, {
      id, eventId, eventName: event.name, subject, message,
      recipients: byEmail.size, sent, failed,
      sentBy: v.payload?.email || null, sentAt: new Date().toISOString(),
    });
  } catch (e) { console.error('ladder-message log failed:', e); }

  return json({ ok: true, sent, failed, recipients: byEmail.size });
};

export const config = { path: '/.netlify/functions/admin-ladder-message' };
