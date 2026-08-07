// netlify/functions/lib/ladder-announce.js
// Fire-once announcement: when a brand-new ladder is created, email every past
// ladder participant (roster OR waitlist, across all ladders in the circuit) to
// let them register. Mirrors the brand of the manual admin-ladder-blast "open"
// mode, but for a single freshly-created event.
//
// Called from admin-ladder-save.js on the CREATE path only. Guarded by an
// `announcedAt` flag on the event so a later edit (same save endpoint) never
// re-blasts. Test seasons are skipped.

import { listEvents, getSignups, spotsLeft, effectiveCapacity } from './ladder.js';
import { sendNotify } from './notify-prefs.js';
import { dateLineOf, siteUrl } from './ladder-notify.js';
import { normalizeEmail } from './identity.js';
import { divisionBadge, divisionTitle, courtsLabel, spotsModule, ctaButton, inviteButton } from './ladder-email-ui.js';

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

function renderNewLadder({ name, event, left, cap, site }) {
  const capacity = cap != null ? cap : effectiveCapacity(event);
  return shell(`
    ${divisionBadge(event.type)}
    <h1 style="font-size:28px;font-weight:800;line-height:1.12;margin:0 0 12px">A fresh <span style="color:#b8ff2c">${esc(divisionTitle(event.type))} Ladder</span> just dropped, ${esc(firstName(name))}.</h1>
    <p style="font-size:15px;color:#cfcfcf;line-height:1.7;margin:0 0 20px">${esc(courtsLabel(event))}, ${esc(capacity)} spots, one night of round-robin — lock your spot before the regulars claim it.</p>
    ${spotsModule({ event, left, cap: capacity, site })}
    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:0 0 18px">
      <div style="font-size:16px;font-weight:800">${esc(event.name)}</div>
      <div style="font-size:13px;color:#17d7b0;font-weight:700;margin-top:5px">${esc(dateLineOf(event))}</div>
      <div style="font-size:12px;color:#8a8a8a;margin-top:7px">📍 ${esc(event.place || '')} · ${esc(courtsLabel(event))} · ${esc(divisionTitle(event.type))}</div>
    </div>
    ${ctaButton(`${site}/ladders.html?event=${encodeURIComponent(event.id)}`, 'Lock My Spot →')}
    ${inviteButton(event, site)}
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
    if (!event || event.status !== 'open' || isTestCircuit(event.circuit) || event.visibility === 'private') {
      return { skipped: true, sent: 0 };
    }
    const site = siteUrl();
    const from = blastFrom();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Send-time spots snapshot (usually full capacity at create, but be exact).
    const su = await getSignups(event.id);
    const left = spotsLeft(event, su);
    const cap = effectiveCapacity(event);

    const people = await pastParticipants(event.circuit || 'I', event.id);
    if (!people.size) return { sent: 0, recipients: 0, note: 'no past participants yet' };

    const subject = `🪜 New ${divisionTitle(event.type)} ladder open: ${event.name}`;
    let sent = 0, failed = 0, skipped = 0;
    for (const [email, name] of people) {
      try {
        const r = await sendNotify({ to: email, from, replyTo: from, category: 'new_ladders', subject, html: renderNewLadder({ name, event, left, cap, site }) });
        if (r && r.skipped) { skipped++; } else { sent++; await sleep(80); }
      } catch { failed++; }
    }
    return { sent, failed, skipped, recipients: people.size };
  } catch (e) {
    return { error: String(e && e.message || e), sent: 0 };
  }
}
