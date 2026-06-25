// netlify/functions/lib/ladder-reminders.js
//
// Automated ladder REMINDER emails to everyone on the roster, so the field knows
// who's coming. Three sends per event:
//   two_day     — ~2 days before start
//   morning     — 5:00 AM on the day of the event
//   three_hour  — 3 hours before start
//
// Each email is personalized (the player's last-ladder line), lists the current
// roster, shows the court numbers + venue, lets them cancel (auto-credit + the
// waitlist fills the spot), and points to the next open ladder.
//
// Idempotent: one marker per (event, kind) in the `ladder-reminders` store, so a
// reminder is sent once. The manual admin push (admin-ladder-remind.js) sets the
// same marker so the automatic send won't duplicate it.

import { getStore } from '@netlify/blobs';
import { sendEmail } from './email.js';
import { siteUrl, dateLineOf, fmtCents } from './ladder-notify.js';
import { listEvents, getSignups, eventStartMs, effectiveCapacity } from './ladder.js';
import { buildLadderProfile } from './profile-data.js';

const MARKERS = 'ladder-reminders';
function markers() { return getStore({ name: MARKERS, consistency: 'strong' }); }
const markerKey = (eventId, kind) => `sent/${eventId}/${kind}.json`;

// Ladder reminders send AS the ladder desk so replies land in that shared inbox.
function ladderFrom() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('LADDER_FROM'))
    || process.env.LADDER_FROM || 'ladder@dinksociety.app';
}

const HOUR = 3600 * 1000;
export const REMINDER_KINDS = ['two_day', 'morning', 'three_hour'];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function shortName(n) { const p = String(n || '').trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : (p[0] || ''); }
function initials(n) { const p = String(n || '').trim().split(/\s+/); return ((p[0] && p[0][0] || '') + (p[1] && p[1][0] || '')).toUpperCase() || '·'; }
function avatarColor(n) { let h = 0, s = String(n || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return ['#b8ff2c', '#17d7b0', '#f0c040', '#ff6fb5', '#3b9eff', '#a78bfa'][h % 6]; }

// 5:00 AM on the event's local date.
function morningMs(event) {
  if (!event?.date) return null;
  const d = new Date(`${event.date}T05:00:00`);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/** The moment a given reminder kind should first fire for this event (epoch ms). */
export function triggerMs(event, kind) {
  const start = eventStartMs(event);
  if (start == null) return null;
  if (kind === 'two_day') return start - 48 * HOUR;
  if (kind === 'three_hour') return start - 3 * HOUR;
  if (kind === 'morning') return morningMs(event);
  return null;
}

/**
 * Whether a reminder is due now: past its trigger, before start, and not so late
 * that it's stale. two_day allows a 12h catch-up window; morning/three_hour run
 * up until start.
 */
export function isDue(event, kind, now = Date.now()) {
  const start = eventStartMs(event);
  const trig = triggerMs(event, kind);
  if (start == null || trig == null) return false;
  if (now >= start) return false;             // never after the ladder starts
  if (now < trig) return false;               // not time yet
  if (kind === 'two_day' && now > trig + 12 * HOUR) return false; // don't fire a stale 2-day blast
  return true;
}

async function markerExists(eventId, kind) {
  const m = await markers().get(markerKey(eventId, kind), { type: 'json' }).catch(() => null);
  return !!m;
}
async function setMarker(eventId, kind, info) {
  await markers().setJSON(markerKey(eventId, kind), { eventId, kind, at: new Date().toISOString(), ...info });
}

// ── next open ladder (for cross-promo) ──
async function nextOpenEvent(circuit, afterStart, excludeId) {
  const all = await listEvents({ circuit });
  const now = Date.now();
  return all
    .filter(e => e.id !== excludeId && e.status !== 'final' && e.status !== 'cancelled')
    .filter(e => { const s = eventStartMs(e); return s != null && s > Math.max(now, afterStart || 0); })
    .sort((a, b) => (eventStartMs(a) || 0) - (eventStartMs(b) || 0))[0] || null;
}

// ── per-player last-ladder personalization ──
function lastLadderLine(profile) {
  const pl = profile && profile.player;
  const last = pl && Array.isArray(pl.perLadder) && pl.perLadder[0];
  if (!last) return null;
  const climb = (last.firstCourt != null && last.lastCourt != null && last.firstCourt !== last.lastCourt)
    ? `court ${last.firstCourt} → ${last.lastCourt}` : null;
  return {
    record: (last.w != null) ? `${last.w}-${last.l}` : null,
    climb,
    place: last.placeRank != null ? last.placeRank : null,
    dr: pl.dr != null ? pl.dr : (last.dr != null ? last.dr : null),
    streak: pl.streak || 0,
  };
}
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

// ── email template ──
const KIND_META = {
  two_day:    { tag: '🪜 Ladder reminder', when: '2 days out', accent: '#17d7b0' },
  morning:    { tag: '🔥 It’s ladder day', when: 'Today', accent: '#b8ff2c' },
  three_hour: { tag: '⏳ 3 hours out', when: '3 hours out', accent: '#b8ff2c' },
};

function statTile(v, l, color) {
  return `<td style="background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:11px 8px;text-align:center;width:25%"><div style="font-size:19px;font-weight:800;color:${color || '#17d7b0'};line-height:1">${esc(v)}</div><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#8a8a8a;margin-top:5px">${esc(l)}</div></td>`;
}

function rosterChips(roster, profileById, meEmail) {
  return roster.map(p => {
    const prof = p.playerId && profileById[p.playerId];
    const dr = prof && prof.player && prof.player.dr != null ? prof.player.dr : null;
    const me = meEmail && String(p.email || '').toLowerCase() === String(meEmail).toLowerCase();
    return `<span style="display:inline-block;margin:0 6px 7px 0;padding:5px 11px 5px 6px;border:1px solid ${me ? '#17d7b0' : '#2a2a2a'};background:${me ? 'rgba(23,215,176,.10)' : '#161616'};border-radius:9999px;font-size:13px;font-weight:600;color:#f5f5f5;white-space:nowrap">`
      + `<span style="display:inline-block;width:20px;height:20px;border-radius:50%;background:${avatarColor(p.name)};color:#06231d;font-size:9px;font-weight:800;text-align:center;line-height:20px;vertical-align:middle;margin-right:6px">${esc(initials(p.name))}</span>`
      + esc(shortName(p.name))
      + (dr != null ? ` <b style="color:#17d7b0;font-weight:800;font-size:11px">${esc(dr)}</b>` : '')
      + `</span>`;
  }).join('');
}

export function renderReminderEmail({ event, kind, recipient, profile, roster, profileById, waitlistCount, capacity, nextEvent }) {
  const meta = KIND_META[kind] || KIND_META.two_day;
  const fn = firstName(recipient.name);
  const site = siteUrl();
  const dateLine = dateLineOf(event);
  const courts = event.courtNumbers ? esc(event.courtNumbers) : `${event.courts || 0} courts`;
  const cancelUrl = `${site}/ladders.html?event=${encodeURIComponent(event.id)}`;
  const paidLine = recipient.amountCents != null ? fmtCents(recipient.amountCents) : (event.feeCents != null ? fmtCents(event.feeCents) : 'your entry fee');

  const ll = lastLadderLine(profile);
  let hype = '';
  let strip = '';
  if (ll) {
    const tiles = [];
    if (ll.record) tiles.push(statTile(ll.record, 'Last record', '#b8ff2c'));
    if (ll.place != null) tiles.push(statTile(ordinal(ll.place), 'Finish', '#f0c040'));
    if (ll.streak >= 2) tiles.push(statTile('W' + ll.streak, 'Streak', '#17d7b0'));
    if (ll.dr != null) tiles.push(statTile(ll.dr, 'Your DR', '#17d7b0'));
    strip = tiles.length ? `<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px;margin:4px 0 16px"><tr>${tiles.slice(0, 4).join('')}</tr></table>` : '';
    const bits = [];
    if (ll.record) bits.push(`went <b style="color:#fff">${esc(ll.record)}</b>`);
    if (ll.climb) bits.push(`climbed ${esc(ll.climb)}`);
    if (ll.place != null && ll.place <= 3) bits.push(`finished <b style="color:#f0c040">${esc(ordinal(ll.place))}</b>`);
    if (bits.length) hype = `<div style="border-left:3px solid #17d7b0;padding:4px 0 4px 15px;margin:14px 0 18px;font-size:15px;font-style:italic;color:#f5f5f5;line-height:1.5">Last ladder you ${bits.join(', ')}.${ll.streak >= 2 ? ' Keep it rolling.' : ' Run it back.'}</div>`;
  }

  const headline = kind === 'morning'
    ? `Tonight's the night,<br><span style="font-style:italic">${esc(fn)}.</span>`
    : kind === 'three_hour'
      ? `3 hours out,<br><span style="font-style:italic">${esc(fn)}.</span>`
      : `You're in,<br><span style="font-style:italic">${esc(fn)}.</span>`;

  const nextBlock = nextEvent ? `
    <div style="background:linear-gradient(135deg,rgba(184,255,44,.07),transparent);border:1px solid rgba(184,255,44,.25);border-radius:12px;padding:15px 18px;margin:22px 0 6px">
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#b8ff2c;margin-bottom:5px">Next ladder</div>
      <div style="font-size:15px;font-weight:800;color:#f5f5f5">${esc(nextEvent.name)}</div>
      <div style="font-size:12.5px;color:#8a8a8a;margin:3px 0 11px">${esc(dateLineOf(nextEvent))}</div>
      <a href="${site}/ladders.html?event=${encodeURIComponent(nextEvent.id)}" style="display:inline-block;padding:11px 24px;background:#b8ff2c;color:#0e0e0e;font-size:13px;font-weight:800;text-decoration:none;border-radius:9999px">Grab a spot →</a>
    </div>` : '';

  return `<div style="background:#0e0e0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;max-width:600px;margin:0 auto;padding:36px 26px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px">
      <span style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#f5f5f5">THE DINK SOCIETY <span style="color:#17d7b0">· LADDER</span></span>
      <span style="font-size:11px;color:#8a8a8a;font-weight:600">${esc(meta.when.toUpperCase())}</span>
    </div>
    <span style="display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:${meta.accent};background:${meta.accent === '#b8ff2c' ? 'rgba(184,255,44,.10)' : 'rgba(23,215,176,.10)'};border:1px solid ${meta.accent === '#b8ff2c' ? 'rgba(184,255,44,.30)' : 'rgba(23,215,176,.30)'};padding:6px 12px;border-radius:9999px;margin-bottom:16px">${esc(meta.tag)}</span>
    <h1 style="font-size:26px;font-weight:800;line-height:1.14;margin:0 0 16px;letter-spacing:-.01em">${headline}</h1>

    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:0 0 18px">
      <div style="font-size:16px;font-weight:800">${esc(event.name)}</div>
      <div style="font-size:13px;color:#cfcfcf;margin-top:5px"><b style="color:#17d7b0">${esc(dateLine)}</b></div>
      <div style="font-size:12px;color:#8a8a8a;margin-top:7px;padding-top:8px;border-top:1px solid #2a2a2a">📍 ${esc(event.place || '')} · 🎾 ${courts} · ${capacity} players · ${esc(event.type || 'mixed')}</div>
    </div>

    ${strip}${hype}

    <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#8a8a8a;margin:18px 0 10px">Who's coming · <span style="color:#17d7b0">${roster.length} registered</span></div>
    <div>${rosterChips(roster, profileById, recipient.email)}</div>
    ${waitlistCount ? `<div style="font-size:12px;color:#8a8a8a;margin-top:8px">${waitlistCount} on the waitlist if a spot opens.</div>` : ''}

    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:22px 0 8px">
      <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#f0c040;margin-bottom:6px">${kind === 'morning' ? '⏰ Last call if you’re out' : '👋 Can’t make it?'}</div>
      <p style="font-size:13.5px;color:#cfcfcf;line-height:1.6;margin:0"><a href="${cancelUrl}" style="color:#f0c040;font-weight:700;text-decoration:none">Cancel your spot</a> and you'll get back <b style="color:#fff">what you paid for this ladder</b> (${esc(paidLine)}) as a credit. The next person on the waitlist takes your place automatically, so the night stays full.</p>
    </div>

    ${nextBlock}

    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;line-height:1.6"><b style="color:#8a8a8a;font-weight:700">THE DINK SOCIETY · LADDER</b> · See you on the courts.<br>You're getting this because you're registered for ${esc(event.name)}.</div>
  </div>`;
}

function subjectFor(event, kind) {
  if (kind === 'morning') return `🪜 Tonight: ${event.name}, ${event.startTime || ''}. You're in.`.trim();
  if (kind === 'three_hour') return `⏳ 3 hours out — ${event.name}. Here's the field.`;
  return `🪜 You're in for ${event.name} — here's the field`;
}

/**
 * Send one reminder kind for an event to everyone on the roster.
 * @returns {{ ok, kind, sent, failed, skipped, reason? }}
 */
export async function sendEventReminder(event, signups, kind, { force = false } = {}) {
  if (!REMINDER_KINDS.includes(kind)) return { ok: false, reason: 'bad-kind' };
  if (!force) {
    if (await markerExists(event.id, kind)) return { ok: false, reason: 'already-sent', kind };
    if (!isDue(event, kind)) return { ok: false, reason: 'not-due', kind };
  }
  const roster = (signups.roster || []).filter(p => p && p.email);
  if (!roster.length) { await setMarker(event.id, kind, { sent: 0, note: 'empty roster' }); return { ok: true, kind, sent: 0, failed: 0, skipped: 0 }; }

  // Build each rostered player's ladder profile once (DR for the list + each
  // recipient's last-ladder line). Players without a ladder id just get generic copy.
  const profileById = {};
  await Promise.all(roster.filter(p => p.playerId).map(async p => {
    try { profileById[p.playerId] = await buildLadderProfile(p.playerId); } catch { /* skip */ }
  }));

  const capacity = effectiveCapacity(event);
  const waitlistCount = (signups.waitlist || []).length;
  const nextEvent = await nextOpenEvent(event.circuit, eventStartMs(event), event.id);
  const from = ladderFrom();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  let sent = 0, failed = 0; const errors = [];
  for (const p of roster) {
    const profile = p.playerId ? profileById[p.playerId] : null;
    try {
      const html = renderReminderEmail({ event, kind, recipient: p, profile, roster, profileById, waitlistCount, capacity, nextEvent });
      await sendEmail({ to: p.email, from, replyTo: from, subject: subjectFor(event, kind), html });
      sent++;
      await sleep(120); // stay under Resend's per-second limit
    } catch (e) { failed++; if (errors.length < 3) errors.push(e.message || String(e)); }
  }
  await setMarker(event.id, kind, { sent, failed, forced: !!force });
  return { ok: true, kind, sent, failed, skipped: 0, errors };
}

/** Cron entry: scan upcoming events and fire any reminders that are due. */
export async function runDueReminders(circuit = 'I') {
  const events = (await listEvents({ circuit }))
    .filter(e => e.status !== 'final' && e.status !== 'cancelled');
  const now = Date.now();
  const out = [];
  for (const event of events) {
    const start = eventStartMs(event);
    if (start == null || start <= now) continue;
    for (const kind of REMINDER_KINDS) {
      if (!isDue(event, kind, now)) continue;
      if (await markerExists(event.id, kind)) continue;
      const signups = await getSignups(event.id);
      const res = await sendEventReminder(event, signups, kind);
      out.push({ event: event.name, ...res });
    }
  }
  return out;
}
