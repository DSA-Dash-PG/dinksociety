// netlify/functions/admin-ladder-blast.js
// POST /api/admin-ladder-blast  (admin session required) — marketing blast to every
// past ladder participant (roster OR waitlist, across all ladders).
//
// Body:
//   { mode: 'recruit', eventId, neededCount? }  → "we need N more for <ladder>"
//   { mode: 'open' }                            → "new ladders are open to register"
//
// Recruit excludes anyone already registered/waitlisted for that event.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { listEvents, getEvent, getSignups, eventStartMs, spotsLeft } from './lib/ladder.js';
import { sendNotify } from './lib/notify-prefs.js';
import { dateLineOf, siteUrl } from './lib/ladder-notify.js';
import { normalizeEmail } from './lib/identity.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function blastFrom() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('LADDER_FROM')) || process.env.LADDER_FROM || 'dink@dinksociety.app';
}

// Every past participant: email → display name (first seen).
async function pastParticipants(circuit) {
  const events = await listEvents({ circuit });
  const byEmail = new Map();
  for (const ev of events) {
    const su = await getSignups(ev.id);
    for (const p of [...(su.roster || []), ...(su.waitlist || [])]) {
      const e = normalizeEmail(p.email);
      if (e && !byEmail.has(e)) byEmail.set(e, p.name || '');
    }
  }
  return byEmail;
}

function shell(inner) {
  return `<div style="background:#0e0e0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;max-width:600px;margin:0 auto;padding:36px 26px">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:22px">THE DINK SOCIETY <span style="color:#17d7b0">· LADDER</span></div>
    ${inner}
    <div style="margin-top:30px;padding-top:16px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;line-height:1.6"><b style="color:#8a8a8a;font-weight:700">THE DINK SOCIETY · LADDER</b> · Open play, round-robin nights.</div>
  </div>`;
}
function btn(url, label, bg = '#b8ff2c', fg = '#0e0e0e') {
  return `<a href="${esc(url)}" style="display:inline-block;padding:13px 30px;background:${bg};color:${fg};font-size:14px;font-weight:800;text-decoration:none;border-radius:9999px;margin:6px 0">${esc(label)}</a>`;
}
function evCard(ev, site) {
  const courts = ev.courtNumbers ? esc(ev.courtNumbers) : `${ev.courts || 0} courts`;
  const spots = ev.spotsLeft != null ? ev.spotsLeft : '';
  return `<div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:0 0 12px">
    <div style="font-size:15px;font-weight:800">${esc(ev.name)}</div>
    <div style="font-size:12.5px;color:#17d7b0;font-weight:700;margin-top:4px">${esc(dateLineOf(ev))}</div>
    <div style="font-size:12px;color:#8a8a8a;margin-top:6px">📍 ${esc(ev.place || '')} · ${courts}${spots !== '' ? ` · ${spots} spot${spots === 1 ? '' : 's'} open` : ''}</div>
    <div style="margin-top:10px">${btn(`${site}/ladders.html?event=${encodeURIComponent(ev.id)}`, 'Register →')}</div>
  </div>`;
}

function renderRecruit({ name, event, needed, site }) {
  const courts = event.courtNumbers ? esc(event.courtNumbers) : `${event.courts || 0} courts`;
  return shell(`
    <span style="display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#b8ff2c;background:rgba(184,255,44,.10);border:1px solid rgba(184,255,44,.30);padding:6px 12px;border-radius:9999px;margin-bottom:14px">Players wanted</span>
    <h1 style="font-size:26px;font-weight:800;line-height:1.15;margin:0 0 12px">We need <span style="color:#b8ff2c">${esc(needed)}</span> more, ${esc(firstName(name))}.</h1>
    <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 16px">A spot (or ${esc(needed)}) just opened up for an upcoming ladder. If you're free, jump in — it fills fast.</p>
    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:0 0 16px">
      <div style="font-size:16px;font-weight:800">${esc(event.name)}</div>
      <div style="font-size:13px;color:#17d7b0;font-weight:700;margin-top:5px">${esc(dateLineOf(event))}</div>
      <div style="font-size:12px;color:#8a8a8a;margin-top:7px">📍 ${esc(event.place || '')} · ${courts} · ${esc(event.type || 'mixed')}</div>
    </div>
    ${btn(`${site}/ladders.html?event=${encodeURIComponent(event.id)}`, `Grab a spot →`)}
    <p style="font-size:12.5px;color:#777;margin-top:16px">Not this time? No worries — you'll always get first look at the next one.</p>
  `);
}
function renderOpen({ name, events, site }) {
  return shell(`
    <span style="display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#17d7b0;background:rgba(23,215,176,.10);border:1px solid rgba(23,215,176,.30);padding:6px 12px;border-radius:9999px;margin-bottom:14px">🪜 New ladders open</span>
    <h1 style="font-size:26px;font-weight:800;line-height:1.15;margin:0 0 12px">Fresh ladders are up, ${esc(firstName(name))}.</h1>
    <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 18px">New ladder nights just opened for registration. Pick one and lock your spot:</p>
    ${events.map(ev => evCard(ev, site)).join('')}
    <p style="font-size:12.5px;color:#777;margin-top:6px">See everything anytime at <a href="${site}/ladders.html" style="color:#17d7b0;text-decoration:none">the ladder page</a>.</p>
  `);
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const b = await req.json().catch(() => ({}));
  const mode = b.mode === 'open' ? 'open' : 'recruit';
  const circuit = b.circuit || 'I';
  const site = siteUrl();
  const from = blastFrom();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const people = await pastParticipants(circuit);
  if (!people.size) return json({ ok: true, sent: 0, recipients: 0, note: 'no past participants yet' });

  let subject, htmlFor, exclude = new Set();

  if (mode === 'recruit') {
    if (!b.eventId) return json({ error: 'eventId required for recruit' }, 400);
    const event = await getEvent(b.eventId);
    if (!event) return json({ error: 'Event not found' }, 404);
    const signups = await getSignups(b.eventId);
    [...(signups.roster || []), ...(signups.waitlist || [])].forEach(p => { const e = normalizeEmail(p.email); if (e) exclude.add(e); });
    const open = spotsLeft(event, signups);
    const needed = (b.neededCount != null && +b.neededCount > 0) ? Math.floor(+b.neededCount) : (open || 1);
    subject = `${needed} spot${needed === 1 ? '' : 's'} open — ${event.name}`;
    htmlFor = (name) => renderRecruit({ name, event, needed, site });
  } else {
    const now = Date.now();
    const events = (await listEvents({ circuit }))
      .filter(e => e.status === 'open')
      .filter(e => { const s = eventStartMs(e); return s != null && s > now; })
      .sort((a, b2) => (eventStartMs(a) || 0) - (eventStartMs(b2) || 0));
    if (!events.length) return json({ error: 'No open upcoming ladders to announce.' }, 400);
    // attach spotsLeft for the cards
    for (const e of events) { const su = await getSignups(e.id); e.spotsLeft = spotsLeft(e, su); }
    subject = events.length === 1 ? `🪜 New ladder open: ${events[0].name}` : `🪜 ${events.length} new ladders open for registration`;
    htmlFor = (name) => renderOpen({ name, events, site });
  }

  let sent = 0, failed = 0, skipped = 0;
  for (const [email, name] of people) {
    if (exclude.has(email)) continue;
    try {
      const r = await sendNotify({ to: email, from, replyTo: from, category: 'new_ladders', subject, html: htmlFor(name) });
      if (r && r.skipped) { skipped++; } else { sent++; await sleep(120); }
    }
    catch { failed++; }
  }
  return json({ ok: true, mode, sent, failed, skipped, recipients: people.size - exclude.size });
};

export const config = { path: '/.netlify/functions/admin-ladder-blast' };
