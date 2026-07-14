// netlify/functions/lib/ladder.js
//
// Storage + helpers for LADDERS — the individual round-robin "ladder night"
// product (distinct from team League play). Two blob stores, both strong
// consistency so the signup/waitlist race is correct (two people tapping the
// last spot must not both win — same rule scores/availability follow):
//
//   ladder-events   event/<id>.json     — the night players sign up for
//   ladder-signups  signup/<eventId>.json — roster + waitlist + the held claim
//
// Money is always integer CENTS. Card adds a flat 10% service fee to cover
// Stripe (~2.9% + 30¢); Venmo pays face value. Cancellations issue ladder
// credit (see lib/credits.js), never refunds.
//
// Waitlist rule: when a spot opens, the next person in line gets PRIORITY with
// a 30-minute window to claim. A last-chance nudge fires ~5 min before expiry;
// if they don't claim in time the spot rolls to the next person. The 30-min
// sweep + nudge run from ladder-cron.js.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';

const EVENTS = 'ladder-events';
const SIGNUPS = 'ladder-signups';

// ── timing constants (exported so the cron + tests agree) ──
export const HOLD_MS = 30 * 60 * 1000;       // claim window for a promoted waitlister
export const NUDGE_LEAD_MS = 5 * 60 * 1000;  // send the "last chance" nudge this long before expiry
export const PAY_HOLD_MS = 30 * 60 * 1000;   // pending-payment hold on a fresh signup
export const FCFS_WINDOW_MS = 24 * 60 * 60 * 1000; // inside this window before start → first-come-first-serve

function eventsStore() { return getStore({ name: EVENTS, consistency: 'strong' }); }
function signupsStore() { return getStore({ name: SIGNUPS, consistency: 'strong' }); }

// ═══════════════════════════════════════════════════════════════
// PURE HELPERS (no I/O) — unit-tested in tests/ladder.test.js
// ═══════════════════════════════════════════════════════════════

/** Default capacity = courts × 4 (doubles). Admin may override on the event. */
export function capacityFromCourts(courts) {
  const c = Math.max(0, Math.floor(Number(courts) || 0));
  return c * 4;
}

/** Card service fee in cents: flat 10% of the entry fee, rounded. */
export function surchargeCents(feeCents) {
  return Math.round((Number(feeCents) || 0) * 0.10);
}

/** What a card payer is charged: entry + 10%. Venmo/credit pay `feeCents`. */
export function cardTotalCents(feeCents) {
  return (Number(feeCents) || 0) + surchargeCents(feeCents);
}

/** Effective capacity for an event (explicit capacity, else courts × 4). */
export function effectiveCapacity(event) {
  if (!event) return 0;
  if (Number.isFinite(+event.capacity) && +event.capacity > 0) return +event.capacity;
  return capacityFromCourts(event.courts);
}

/**
 * Spots left = capacity − roster − (an outstanding held claim, which is a
 * reserved spot). Never negative.
 */
export function spotsLeft(event, signups) {
  const cap = effectiveCapacity(event);
  const roster = (signups?.roster || []).length;
  const held = signups?.pendingClaim ? 1 : 0;
  return Math.max(0, cap - roster - held);
}

export function isFull(event, signups) {
  return spotsLeft(event, signups) <= 0;
}

/** A promoted-but-unclaimed spot is overdue and should roll to the next person. */
export function claimExpired(pendingClaim, now = Date.now()) {
  if (!pendingClaim?.claimDeadline) return false;
  return new Date(pendingClaim.claimDeadline).getTime() <= now;
}

/**
 * True when we should send the last-chance nudge: inside the lead window, not
 * yet expired, and not already nudged.
 */
export function nudgeDue(pendingClaim, now = Date.now(), leadMs = NUDGE_LEAD_MS) {
  if (!pendingClaim?.claimDeadline || pendingClaim.nudgedAt) return false;
  const deadline = new Date(pendingClaim.claimDeadline).getTime();
  if (now >= deadline) return false;               // already expired → cron expires it instead
  return now >= deadline - leadMs;                 // within the final `leadMs` → nudge
}

/** Minutes (rounded, min 1) remaining until a claim expires — for email copy. */
export function minutesLeft(pendingClaim, now = Date.now()) {
  if (!pendingClaim?.claimDeadline) return 0;
  const ms = new Date(pendingClaim.claimDeadline).getTime() - now;
  return Math.max(1, Math.round(ms / 60000));
}

/**
 * Parse a start time into { h, m }, or null. Accepts the formats admins
 * actually type: "8:30 AM", "6:30 PM", "18:30", "6.30pm", "630pm", "6pm",
 * "1830". The old colon-only regex silently failed on "630pm", which made
 * eventStartMs fall back to MIDNIGHT — so the "3 hours out" reminder fired
 * at 9pm the night before.
 */
export function parseTime(s) {
  if (!s) return null;
  const str = String(s).trim().toLowerCase().replace(/\s+/g, '');
  // "6:30pm" / "6.30pm" / "18:30"
  let m = str.match(/^(\d{1,2})[:.](\d{2})(am|pm)?$/);
  // "630pm" / "1130am" — am/pm required (a bare "630" is ambiguous)
  if (!m) m = str.match(/^(\d{1,2})(\d{2})(am|pm)$/);
  // "6pm" / "11am"
  if (!m) {
    const m2 = str.match(/^(\d{1,2})(am|pm)$/);
    if (m2) m = [m2[0], m2[1], '00', m2[2]];
  }
  // "1830" — 24h military, no am/pm
  if (!m) {
    const m3 = str.match(/^(\d{2})(\d{2})$/);
    if (m3 && +m3[1] <= 23) m = [m3[0], m3[1], m3[2], undefined];
  }
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

// All event dates/times are wall-clock times in the league's timezone. Netlify
// functions run in UTC, so parsing "2026-07-02T05:00:00" with new Date() lands
// 7-8 hours early in Pacific time (that bug fired "morning of" reminders at
// 10 PM the night before). Always convert through LADDER_TZ instead.
export const LADDER_TZ = process.env.LADDER_TZ || 'America/Los_Angeles';

// Offset (ms) between UTC and `timeZone` at the moment `utcMs`.
function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = {};
  for (const { type, value } of parts) p[type] = value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - utcMs;
}

/**
 * Epoch ms for a wall-clock time ("YYYY-MM-DD" + h/m) in the league timezone.
 * Two-pass so DST transitions resolve correctly.
 */
export function zonedTimeMs(dateStr, h = 0, m = 0, timeZone = LADDER_TZ) {
  const md = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!md) return null;
  const wall = Date.UTC(+md[1], +md[2] - 1, +md[3], h, m, 0);
  let ms = wall - tzOffsetMs(wall, timeZone);
  ms = wall - tzOffsetMs(ms, timeZone);
  return ms;
}

/** Event start as epoch ms (from date + startTime, league timezone), or null. */
export function eventStartMs(event) {
  if (!event?.date) return null;
  const t = parseTime(event.startTime) || { h: 0, m: 0 };
  return zonedTimeMs(event.date, t.h, t.m);
}

/**
 * True when we're inside the first-come-first-serve window before start (default
 * 24h) and the event hasn't started yet. An event may override with
 * `fcfsWindowHours`. When the start time can't be parsed we default to the normal
 * priority queue (returns false).
 */
export function isLastDay(event, now = Date.now()) {
  const start = eventStartMs(event);
  if (start == null) return false;
  const windowMs = Number.isFinite(+event?.fcfsWindowHours)
    ? +event.fcfsWindowHours * 3600 * 1000 : FCFS_WINDOW_MS;
  return now < start && (start - now) <= windowMs;
}

/** Normalize a signups record so callers can always read .roster/.waitlist. */
export function normalizeSignups(eventId, rec) {
  return {
    eventId,
    roster: Array.isArray(rec?.roster) ? rec.roster : [],
    waitlist: Array.isArray(rec?.waitlist) ? rec.waitlist : [],
    pendingClaim: rec?.pendingClaim || null,
    updatedAt: rec?.updatedAt || null,
  };
}

/** True if this email already appears anywhere in the signups record. */
export function findEntry(rec, email) {
  const norm = normalizeEmail(email);
  if (!norm) return null;
  const inRoster = (rec.roster || []).find(p => normalizeEmail(p.email) === norm);
  if (inRoster) return { list: 'roster', entry: inRoster };
  const inWait = (rec.waitlist || []).find(p => normalizeEmail(p.email) === norm);
  if (inWait) return { list: 'waitlist', entry: inWait };
  if (rec.pendingClaim && normalizeEmail(rec.pendingClaim.email) === norm) {
    return { list: 'claim', entry: rec.pendingClaim };
  }
  return null;
}

/**
 * Add a person to a signups record (MUTATES + returns {list, position}).
 * Goes to the roster if there's room, otherwise the waitlist. Caller persists.
 */
export function addSignup(rec, event, person, now = Date.now()) {
  const existing = findEntry(rec, person.email);
  if (existing) return { list: existing.list, position: null, duplicate: true };

  if (spotsLeft(event, rec) > 0) {
    rec.roster.push({
      playerId: person.playerId || null,
      name: person.name || '',
      email: (person.email || '').toLowerCase(),
      gender: person.gender || null,
      signedUpAt: new Date(now).toISOString(),
      paymentMethod: person.paymentMethod || null,
      paymentStatus: person.paymentStatus || 'pending',
      amountCents: person.amountCents ?? null,
      checkoutSessionId: person.checkoutSessionId || null,
      invitedBy: person.invitedBy || null,
      heldUntil: new Date(now + PAY_HOLD_MS).toISOString(),
    });
    return { list: 'roster', position: rec.roster.length };
  }

  rec.waitlist.push({
    playerId: person.playerId || null,
    name: person.name || '',
    email: (person.email || '').toLowerCase(),
    gender: person.gender || null,
    joinedAt: new Date(now).toISOString(),
    invitedBy: person.invitedBy || null,
  });
  return { list: 'waitlist', position: rec.waitlist.length };
}

/**
 * Move a waitlisted player straight onto the roster (MUTATES) — used in the
 * first-come-first-serve window when a waitlister grabs an open spot. Returns the
 * new roster entry, or null if they weren't on the waitlist.
 */
export function moveWaitlistToRoster(rec, { playerId, email } = {}, now = Date.now()) {
  const norm = normalizeEmail(email);
  const i = rec.waitlist.findIndex(p =>
    (playerId && p.playerId === playerId) || (norm && normalizeEmail(p.email) === norm));
  if (i < 0) return null;
  const w = rec.waitlist.splice(i, 1)[0];
  rec.roster.push({
    playerId: w.playerId || null, name: w.name, email: w.email, gender: w.gender || null,
    signedUpAt: new Date(now).toISOString(), paymentMethod: null, paymentStatus: 'pending',
    amountCents: null, checkoutSessionId: null, invitedBy: w.invitedBy || null,
    heldUntil: new Date(now + PAY_HOLD_MS).toISOString(),
  });
  return rec.roster[rec.roster.length - 1];
}

/** Remove a player from the roster by playerId or email (MUTATES). Returns removed entry or null. */
export function removeFromRoster(rec, { playerId, email } = {}) {
  const norm = normalizeEmail(email);
  const i = rec.roster.findIndex(p =>
    (playerId && p.playerId === playerId) || (norm && normalizeEmail(p.email) === norm));
  if (i < 0) return null;
  return rec.roster.splice(i, 1)[0];
}

/**
 * If a roster spot is free and no claim is outstanding, promote the head of the
 * waitlist into a held claim with a 30-min deadline (MUTATES). Returns the
 * promoted person (to email) or null. Honors policy: 'auto' drops them straight
 * onto the roster (still pending payment); 'hold' makes them claim.
 */
export function promoteHead(rec, event, now = Date.now()) {
  if (rec.pendingClaim) return null;
  if (spotsLeft(event, rec) <= 0) return null;
  if (!rec.waitlist.length) return null;

  // Final 24h → no priority hold. Leave the spot OPEN and signal callers to tell
  // the whole waitlist it's first-come-first-serve.
  if (isLastDay(event, now)) return { fcfs: true };

  const next = rec.waitlist.shift();
  if ((event?.spotOpenPolicy || 'hold') === 'auto') {
    rec.roster.push({
      playerId: next.playerId || null, name: next.name, email: next.email, gender: next.gender || null,
      signedUpAt: new Date(now).toISOString(), paymentMethod: null, paymentStatus: 'pending',
      amountCents: null, checkoutSessionId: null, invitedBy: next.invitedBy || null,
      heldUntil: new Date(now + PAY_HOLD_MS).toISOString(),
    });
    return { ...next, autoClaimed: true };
  }
  rec.pendingClaim = {
    playerId: next.playerId || null, name: next.name, email: next.email, gender: next.gender || null,
    invitedBy: next.invitedBy || null,
    promotedAt: new Date(now).toISOString(),
    claimDeadline: new Date(now + HOLD_MS).toISOString(),
    nudgedAt: null,
  };
  return { ...rec.pendingClaim, autoClaimed: false };
}

/** The promoted person accepts their spot (MUTATES). Returns true if claimed. */
export function claimSpot(rec, { playerId, email } = {}, now = Date.now()) {
  const pc = rec.pendingClaim;
  if (!pc) return false;
  const norm = normalizeEmail(email);
  const match = (playerId && pc.playerId === playerId) || (norm && normalizeEmail(pc.email) === norm);
  if (!match) return false;
  if (claimExpired(pc, now)) return false;
  rec.roster.push({
    playerId: pc.playerId, name: pc.name, email: pc.email, gender: pc.gender || null,
    signedUpAt: new Date(now).toISOString(), paymentMethod: null, paymentStatus: 'pending',
    amountCents: null, checkoutSessionId: null, invitedBy: pc.invitedBy || null,
    heldUntil: new Date(now + PAY_HOLD_MS).toISOString(),
  });
  rec.pendingClaim = null;
  return true;
}

/** Drop an expired claim (MUTATES). Returns the expired person or null. */
export function expireClaim(rec, now = Date.now()) {
  if (rec.pendingClaim && claimExpired(rec.pendingClaim, now)) {
    const gone = rec.pendingClaim;
    rec.pendingClaim = null;
    return gone;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// STORAGE (I/O)
// ═══════════════════════════════════════════════════════════════

export async function getEvent(id) {
  return eventsStore().get(`event/${id}.json`, { type: 'json' }).catch(() => null);
}

export async function setEvent(event) {
  if (!event?.id) throw new Error('event.id required');
  event.updatedAt = new Date().toISOString();
  await eventsStore().setJSON(`event/${event.id}.json`, event);
  return event;
}

export async function listEvents({ circuit } = {}) {
  const s = eventsStore();
  const { blobs } = await s.list({ prefix: 'event/' }).catch(() => ({ blobs: [] }));
  const out = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
  const filtered = circuit ? out.filter(e => e.circuit === circuit) : out;
  filtered.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return filtered;
}

export async function getSignups(eventId) {
  const rec = await signupsStore().get(`signup/${eventId}.json`, { type: 'json' }).catch(() => null);
  return normalizeSignups(eventId, rec);
}

export async function setSignups(rec) {
  if (!rec?.eventId) throw new Error('signups.eventId required');
  rec.updatedAt = new Date().toISOString();
  await signupsStore().setJSON(`signup/${rec.eventId}.json`, rec);
  return rec;
}

/** Public-safe projection of a signups record (drops emails). */
export function toPublicSignups(event, rec) {
  return {
    eventId: rec.eventId,
    capacity: effectiveCapacity(event),
    spotsLeft: spotsLeft(event, rec),
    rosterCount: (rec.roster || []).length,
    waitlistCount: (rec.waitlist || []).length,
    roster: (rec.roster || []).map(p => ({ name: p.name, gender: p.gender, paid: p.paymentStatus === 'paid' })),
  };
}
