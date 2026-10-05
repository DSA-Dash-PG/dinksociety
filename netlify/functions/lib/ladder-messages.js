// netlify/functions/lib/ladder-messages.js
//
// Messages to the players of ONE ladder — the roster, the waitlist, or both.
// Used by admin-ladder-message.js (admins, and organizers for their own
// ladders) and read back by player-ladder-events.js so a signed-up player also
// sees the update in the portal, not only in their inbox.
//
// These are operational messages about a ladder someone is signed up for
// (the time moved, the courts changed), so they always deliver and do not go
// through the optional notify-prefs categories.
//
// Storage (store `ladder-messages`):
//   event/<eventId>.json   { messages: [newest first, capped] }  ← what is read
//   message/<id>.json      one record per send (the original audit trail)

import { getStore } from '@netlify/blobs';
import { getSignups } from './ladder.js';
import { sendEmail } from './email.js';
import { dateLineOf, siteUrl } from './ladder-notify.js';
import { normalizeEmail } from './identity.js';
import { getDirectory, applyDirectoryToSignups } from './player-directory.js';

const STORE = 'ladder-messages';
const KEEP = 60;
function store() { return getStore({ name: STORE, consistency: 'strong' }); }
const indexKey = (eventId) => `event/${eventId}.json`;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
export function messageFrom() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('LADDER_FROM')) || process.env.LADDER_FROM || 'dink@dinksociety.app';
}

// ── message body helpers ──

/** Plain text → safe HTML: escape, then turn newlines into breaks/paragraphs. */
export function textToHtml(text) {
  return String(text || '').trim().split(/\n{2,}/).map(block =>
    `<p style="margin:0 0 14px">${esc(block).replace(/\n/g, '<br>')}</p>`
  ).join('');
}

/** True when the HTML has no visible content (an empty contenteditable leaves <div><br></div>). */
export function isBlankHtml(html) {
  return !String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// Minimal allowlist sanitizer for the rich text editor. Senders are admins or
// approved organizers, so the point is not a hostile stranger: it is making
// sure whatever a contenteditable produced cannot carry a <script>, an inline
// event handler or a javascript: link into an email (or into the player
// portal, which shows the same HTML). No DOM parser in this runtime, so this is
// a conservative regex pass: strip script/style blocks, unwrap any tag not on
// the allowlist (keep its text), and drop every attribute except a
// scheme-checked href on <a>.
const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'SPAN', 'A', 'BLOCKQUOTE']);
export function sanitizeMessageHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (m, tag, attrs) => {
      const T = tag.toUpperCase();
      const closing = m.startsWith('</');
      if (!ALLOWED_TAGS.has(T)) return '';
      if (closing) return `</${T.toLowerCase()}>`;
      if (T === 'A') {
        const hrefMatch = attrs.match(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        const raw = ((hrefMatch && (hrefMatch[1] || hrefMatch[2])) || '').trim();
        if (!/^(https?:|mailto:)/i.test(raw)) return '<a>';
        return `<a href="${raw.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer">`;
      }
      return `<${T.toLowerCase()}>`;
    });
}

// ── what changed on a save ──

function dayLabel(date) {
  if (!date) return '';
  const d = new Date(`${date}T12:00:00Z`);
  return isNaN(d) ? String(date) : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const norm = (v) => String(v == null ? '' : v).trim();

/**
 * The player-facing differences between two versions of an event: the things
 * someone signed up needs to hear about. Pure. Returns [] when nothing a player
 * would care about changed (name, fee, capacity, notes and so on are ignored).
 * @returns {{ field, label, from, to }[]}
 */
export function describeChanges(before, after) {
  if (!before || !after) return [];
  const out = [];
  const add = (field, label, from, to) => { if (norm(from) !== norm(to)) out.push({ field, label, from: norm(from), to: norm(to) }); };
  add('date', 'Date', dayLabel(before.date), dayLabel(after.date));
  add('startTime', 'Start time', before.startTime, after.startTime);
  add('endTime', 'End time', before.endTime, after.endTime);
  add('place', 'Location', before.place, after.place);
  add('address', 'Address', before.address, after.address);
  add('courts', 'Courts', before.courtNumbers || (before.courts ? `${before.courts} courts` : ''), after.courtNumbers || (after.courts ? `${after.courts} courts` : ''));
  return out;
}

/** "Start time: 6:00 PM → 7:00 PM" (or "Address: 123 Main St" when it was blank before). */
export function changeLine(c) {
  if (!c.from) return `${c.label}: ${c.to}`;
  if (!c.to) return `${c.label}: removed (was ${c.from})`;
  return `${c.label}: ${c.from} → ${c.to}`;
}

/** Does this set of changes move when the ladder starts? (Reminders need resetting.) */
export function changesMoveStart(changes) {
  return (changes || []).some(c => c.field === 'date' || c.field === 'startTime');
}

// ── who gets it ──

/**
 * Recipients for a message. Pure.
 * @param signups  { roster, waitlist }
 * @param audience { roster?: boolean, waitlist?: boolean, only?: 'dupr-unverified' }
 * @returns {{ email, name, list }[]} deduped by email, roster first
 */
export function pickRecipients(signups, audience = {}) {
  const wantRoster = audience.roster !== false;
  const wantWait = !!audience.waitlist;
  const keep = (p) => audience.only === 'dupr-unverified' ? p.duprClub !== 'verified' : true;
  const seen = new Map();
  const take = (list, label) => {
    for (const p of (list || [])) {
      const e = normalizeEmail(p && p.email);
      if (!e || seen.has(e) || !keep(p)) continue;
      seen.set(e, { email: e, name: p.name || '', list: label });
    }
  };
  if (wantRoster) take(signups && signups.roster, 'roster');
  if (wantWait) take(signups && signups.waitlist, 'waitlist');
  return [...seen.values()];
}

/** Head counts for the "send to" choices in the editor. */
export function audienceCounts(signups) {
  const withEmail = (l) => pickRecipients({ roster: l }, { roster: true }).length;
  return {
    roster: withEmail(signups && signups.roster),
    waitlist: withEmail(signups && signups.waitlist),
    duprUnverified: pickRecipients(signups, { roster: true, only: 'dupr-unverified' }).length,
  };
}

// ── the email ──

function shell(inner) {
  return `<div style="background:#0e0e0e;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;max-width:600px;margin:0 auto;padding:36px 26px">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:22px">THE DINK SOCIETY <span style="color:#17d7b0">· LADDER</span></div>
    ${inner}
    <div style="margin-top:30px;padding-top:16px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;line-height:1.6"><b style="color:#8a8a8a;font-weight:700">THE DINK SOCIETY · LADDER</b> · You're getting this because you signed up for this ladder.</div>
  </div>`;
}

export function renderLadderMessage({ name, event, site, kind, bodyHtml, list }) {
  const tag = kind === 'update' ? 'Ladder update' : 'Message about your ladder';
  const where = event.place
    ? `<a href="https://maps.google.com/?q=${encodeURIComponent(event.address || event.place)}" style="color:#cfcfcf;text-decoration:underline">${esc(event.place)}</a>`
    : '';
  const when = dateLineOf({ date: event.date, startTime: event.startTime });
  const courts = event.courtNumbers ? `Courts ${esc(event.courtNumbers)}` : '';
  return shell(`
    <span style="display:inline-block;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#17d7b0;background:rgba(23,215,176,.10);border:1px solid rgba(23,215,176,.30);padding:6px 12px;border-radius:9999px;margin-bottom:14px">${tag}</span>
    <h1 style="font-size:24px;font-weight:800;line-height:1.15;margin:0 0 18px">Hey ${esc(firstName(name))},</h1>
    <div style="font-size:15px;color:#e7eaee;line-height:1.7;margin:0 0 22px">${bodyHtml}</div>
    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 18px;margin:0 0 20px">
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#8a8a8a;margin-bottom:6px">${list === 'waitlist' ? 'You are on the waitlist for' : 'The details now'}</div>
      <div style="font-size:16px;font-weight:800">${esc(event.name)}</div>
      ${when ? `<div style="font-size:13px;color:#17d7b0;font-weight:700;margin-top:5px">${esc(when)}${event.endTime ? ' to ' + esc(event.endTime) : ''}</div>` : ''}
      ${where || courts ? `<div style="font-size:13px;color:#cfcfcf;margin-top:6px">${[where, courts].filter(Boolean).join(' · ')}</div>` : ''}
    </div>
    <a href="${site}/ladders.html?event=${encodeURIComponent(event.id)}" style="display:inline-block;padding:14px 30px;background-color:#b8ff2c;color:#0e0e0e;font-size:14px;font-weight:800;text-decoration:none;border-radius:9999px;margin:2px 0">View this ladder</a>
  `);
}

// ── log ──

/** Every message sent to this ladder, newest first. */
export async function listEventMessages(eventId) {
  if (!eventId) return [];
  const idx = await store().get(indexKey(eventId), { type: 'json' }).catch(() => null);
  if (idx && Array.isArray(idx.messages)) return idx.messages;
  // First read for this ladder: pick up anything sent before the per-ladder
  // index existed (those only have message/<id>.json records), then save it.
  const found = [];
  try {
    const { blobs } = await store().list({ prefix: 'message/' });
    for (const b of (blobs || [])) {
      const m = await store().get(b.key, { type: 'json' }).catch(() => null);
      if (m && m.eventId === eventId) found.push(m);
    }
  } catch { /* nothing logged yet */ }
  found.sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || '')));
  try { await store().setJSON(indexKey(eventId), { messages: found.slice(0, KEEP) }); } catch { /* best effort */ }
  return found;
}

async function logMessage(rec) {
  try { await store().setJSON(`message/${rec.id}.json`, rec); } catch (e) { console.error('ladder-message log failed:', e); }
  try {
    const prev = await listEventMessages(rec.eventId);
    await store().setJSON(indexKey(rec.eventId), { messages: [rec, ...prev.filter(m => m.id !== rec.id)].slice(0, KEEP) });
  } catch (e) { console.error('ladder-message index failed:', e); }
}

/**
 * What a signed-up player sees in the portal: the newest messages that were
 * addressed to their list. Messages narrowed to a sub-group (for example the
 * DUPR club nudge) are left out, since they were not meant for everyone.
 */
export async function updatesForPlayer(eventId, list, max = 3) {
  const all = await listEventMessages(eventId).catch(() => []);
  return all
    .filter(m => {
      const a = m.audience || { roster: true };
      if (a.only) return false;
      // A held claim is someone just promoted off the waitlist.
      return (list === 'waitlist' || list === 'claim') ? !!a.waitlist : a.roster !== false;
    })
    .slice(0, max)
    .map(m => ({
      id: m.id, kind: m.kind || 'message', subject: m.subject || '', text: m.message || '', html: m.messageHtml || '', sentAt: m.sentAt || null,
      // "Start time: 6:00 PM → 7:00 PM" lines, so the portal can show what moved at a glance.
      changes: Array.isArray(m.changes) ? m.changes.map(changeLine) : [],
    }));
}

// ── send ──

/**
 * Email a message to a ladder's players and log it.
 * @returns {{ ok, sent, failed, recipients, id }}
 */
export async function sendLadderMessage({ event, subject, bodyHtml, audience = { roster: true }, kind = 'message', changes = null, sentBy = null, role = 'admin', replyTo = null, signups = null }) {
  const raw = signups || await getSignups(event.id);
  const withDir = applyDirectoryToSignups(raw, await getDirectory().catch(() => ({})));
  const people = pickRecipients(withDir, audience);
  if (!people.length) return { ok: true, sent: 0, failed: 0, recipients: 0, note: 'Nobody with an email matches that choice yet.' };

  const site = siteUrl();
  const from = messageFrom();
  const subj = String(subject || '').trim() || (kind === 'update' ? `Update: ${event.name}` : `About ${event.name}`);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  let sent = 0, failed = 0;
  for (const p of people) {
    try {
      await sendEmail({
        to: p.email, from, replyTo: replyTo || from,
        subject: `${subj} — The Dink Society`,
        html: renderLadderMessage({ name: p.name, event, site, kind, bodyHtml, list: p.list }),
      });
      sent++;
      await sleep(120); // stay under the mail provider's per-second limit
    } catch (e) {
      console.error('ladder message send failed:', e);
      failed++;
    }
  }

  const id = 'lm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const plainPreview = bodyHtml.replace(/<\/(p|div|li|br)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  await logMessage({
    id, eventId: event.id, eventName: event.name, subject: subj, kind, format: 'html',
    message: plainPreview, messageHtml: bodyHtml,
    audience: { roster: audience.roster !== false, waitlist: !!audience.waitlist, ...(audience.only ? { only: audience.only } : {}) },
    changes: Array.isArray(changes) && changes.length ? changes : null,
    recipients: people.length, sent, failed,
    sentBy, role, sentAt: new Date().toISOString(),
  });
  return { ok: true, sent, failed, recipients: people.length, id };
}
