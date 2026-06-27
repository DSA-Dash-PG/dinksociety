// netlify/functions/lib/ladder-announce.js
// Fire-once announcement: when a brand-new ladder is created, email every past
// ladder participant (roster OR waitlist, across all ladders in the circuit) to
// let them register. Mirrors the brand of the manual admin-ladder-blast "open"
// mode, but for a single freshly-created event.
//
// Called from admin-ladder-save.js on the CREATE path only. Guarded by an
// `announcedAt` flag on the event so a later edit (same save endpoint) never
// re-blasts. Test seasons are skipped.

import { listEvents, getSignups } from './ladder.js';
import { sendNotify } from './notify-prefs.js';
import { dateLineOf, siteUrl } from './ladder-notify.js';
import { normalizeEmail } from './identity.js';

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function blastFrom() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('LADDER_FROM')) || process.env.LADDER_FROM || 'dink@dinksociety.app';
}

// Don't announce QA/test seasons to the real mailing list.
function isTestCircuit(circuit) {
  return String(circuit || '').toLowerCase().includes('test');
}

// Every past participant in the circuit: email → display name (first seen).
// Excludes the new event itself (nobody's registered yet, but be safe).
async function pastParticipants(circuit, excludeEventId) {
  const events = await listEvents({ circuit });
  const byEmail = new Map();
  for (const ev of events) {
    if (ev.id === excludeEventId) continue;
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

function renderNewLadder({ name, event, site }) {
  const courts = event.courtNumbers ? esc(event.courtNumbers) : `${event.courts || 0} courts`;
  const spots = event.capacity != null ? `${event.capacity} spots` : '';
  return shell(`
    <span style="display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#17d7b0;background:rgba(23,215,176,.10);border:1px solid rgba(23,215,176,.30);padding:6px 12px;border-radius:9999px;margin-bottom:14px">🪜 New ladder open</span>
    <h1 style="font-size:26px;font-weight:800;line-height:1.15;margin:0 0 12px">Fresh ladder is up, ${esc(firstName(name))}.</h1>
    <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 16px">A new ladder night just opened for registration. Lock your spot before it fills:</p>
    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:0 0 16px">
      <div style="font-size:16px;font-weight:800">${esc(event.name)}</div>
      <div style="font-size:13px;color:#17d7b0;font-weight:700;margin-top:5px">${esc(dateLineOf(event))}</div>
      <div style="font-size:12px;color:#8a8a8a;margin-top:7px">📍 ${esc(event.place || '')} · ${courts}${spots ? ` · ${spots}` : ''} · ${esc(event.type || 'mixed')}</div>
    </div>
    ${btn(`${site}/ladders.html?event=${encodeURIComponent(event.id)}`, 'Register →')}
    <p style="font-size:12.5px;color:#777;margin-top:16px">See everything anytime at <a href="${site}/ladders.html" style="color:#17d7b0;text-decoration:none">the ladder page</a>.</p>
  `);
}

/**
 * Announce a newly-created ladder to all past participants in its circuit.
 * Returns { sent, failed, recipients }. Never throws — email failure must not
 * block ladder creation.
 * @param {object} event the freshly-saved event record
 */
export async function announceNewLadder(event) {
  try {
    if (!event || event.status !== 'open' || isTestCircuit(event.circuit)) {
      return { skipped: true, sent: 0 };
    }
    const site = siteUrl();
    const from = blastFrom();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const people = await pastParticipants(event.circuit || 'I', event.id);
    if (!people.size) return { sent: 0, recipients: 0, note: 'no past participants yet' };

    const subject = `🪜 New ladder open: ${event.name}`;
    let sent = 0, failed = 0, skipped = 0;
    for (const [email, name] of people) {
      try {
        const r = await sendNotify({ to: email, from, replyTo: from, category: 'new_ladders', subject, html: renderNewLadder({ name, event, site }) });
        if (r && r.skipped) { skipped++; } else { sent++; await sleep(80); }
      } catch { failed++; }
    }
    return { sent, failed, skipped, recipients: people.size };
  } catch (e) {
    return { error: String(e && e.message || e), sent: 0 };
  }
}
