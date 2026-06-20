// tests/ladder.test.js
// Unit tests for the pure ladder + credit helpers (no I/O).
// Run with: npm test   (Node's built-in runner — no dependencies)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capacityFromCourts, surchargeCents, cardTotalCents, effectiveCapacity,
  spotsLeft, isFull, normalizeSignups, addSignup, removeFromRoster,
  promoteHead, claimSpot, claimExpired, expireClaim, nudgeDue, minutesLeft,
  parseTime, eventStartMs, isLastDay, moveWaitlistToRoster,
  HOLD_MS, NUDGE_LEAD_MS,
} from '../netlify/functions/lib/ladder.js';
import { balanceFromLedger, normalizeCredit } from '../netlify/functions/lib/credits.js';

test('capacity = courts × 4, with explicit override', () => {
  assert.equal(capacityFromCourts(3), 12);
  assert.equal(capacityFromCourts(0), 0);
  assert.equal(effectiveCapacity({ courts: 2 }), 8);
  assert.equal(effectiveCapacity({ courts: 2, capacity: 6 }), 6);
});

test('card surcharge is a flat 10% in cents', () => {
  assert.equal(surchargeCents(700), 70);
  assert.equal(cardTotalCents(700), 770);
  assert.equal(cardTotalCents(1000), 1100);
});

test('signup fills roster, then overflows to waitlist', () => {
  const ev = { id: 'e1', capacity: 2, feeCents: 700, spotOpenPolicy: 'hold' };
  const rec = normalizeSignups('e1', null);

  assert.deepEqual(addSignup(rec, ev, { name: 'A', email: 'a@x.com' }), { list: 'roster', position: 1 });
  assert.deepEqual(addSignup(rec, ev, { name: 'B', email: 'b@x.com' }), { list: 'roster', position: 2 });
  assert.equal(isFull(ev, rec), true);
  assert.equal(spotsLeft(ev, rec), 0);

  const c = addSignup(rec, ev, { name: 'C', email: 'c@x.com' });
  assert.deepEqual(c, { list: 'waitlist', position: 1 });

  // duplicate email is rejected
  const dup = addSignup(rec, ev, { name: 'A again', email: 'A@x.com' });
  assert.equal(dup.duplicate, true);
});

test('cancel opens a spot; head of waitlist is promoted to a 30-min held claim', () => {
  const ev = { id: 'e1', capacity: 2, feeCents: 700, spotOpenPolicy: 'hold' };
  const rec = normalizeSignups('e1', null);
  addSignup(rec, ev, { name: 'A', email: 'a@x.com' });
  addSignup(rec, ev, { name: 'B', email: 'b@x.com' });
  addSignup(rec, ev, { name: 'C', email: 'c@x.com' }); // waitlist

  const removed = removeFromRoster(rec, { email: 'a@x.com' });
  assert.equal(removed.name, 'A');
  assert.equal(spotsLeft(ev, rec), 1);

  const now = Date.UTC(2026, 5, 20, 8, 0, 0);
  const promoted = promoteHead(rec, ev, now);
  assert.equal(promoted.name, 'C');
  assert.equal(promoted.autoClaimed, false);
  assert.ok(rec.pendingClaim);
  // held spot counts against capacity → no spots left while the claim is live
  assert.equal(spotsLeft(ev, rec), 0);
  assert.equal(new Date(rec.pendingClaim.claimDeadline).getTime(), now + HOLD_MS);
  assert.equal(rec.waitlist.length, 0);
});

test('auto-claim policy drops the next person straight onto the roster', () => {
  const ev = { id: 'e1', capacity: 1, feeCents: 700, spotOpenPolicy: 'auto' };
  const rec = normalizeSignups('e1', null);
  addSignup(rec, ev, { name: 'A', email: 'a@x.com' });
  addSignup(rec, ev, { name: 'C', email: 'c@x.com' }); // waitlist
  removeFromRoster(rec, { email: 'a@x.com' });
  const promoted = promoteHead(rec, ev);
  assert.equal(promoted.autoClaimed, true);
  assert.equal(rec.roster.length, 1);
  assert.equal(rec.roster[0].name, 'C');
  assert.equal(rec.pendingClaim, null);
});

test('claimSpot moves the held person onto the roster before the deadline', () => {
  const ev = { id: 'e1', capacity: 1, feeCents: 700, spotOpenPolicy: 'hold' };
  const rec = normalizeSignups('e1', null);
  addSignup(rec, ev, { name: 'A', email: 'a@x.com' });
  addSignup(rec, ev, { name: 'C', email: 'c@x.com' });
  removeFromRoster(rec, { email: 'a@x.com' });
  const now = Date.now();
  promoteHead(rec, ev, now);
  assert.equal(claimSpot(rec, { email: 'c@x.com' }, now + 60000), true);
  assert.equal(rec.roster.some(p => p.email === 'c@x.com'), true);
  assert.equal(rec.pendingClaim, null);
});

test('claim expiry: nudge fires in the last 5 min, then the claim expires', () => {
  const now = Date.UTC(2026, 5, 20, 8, 0, 0);
  const pc = { email: 'c@x.com', claimDeadline: new Date(now + HOLD_MS).toISOString(), nudgedAt: null };

  // 20 min left → no nudge yet
  assert.equal(nudgeDue(pc, now + 10 * 60000), false);
  // 4 min left → nudge due
  assert.equal(nudgeDue(pc, now + 26 * 60000), true);
  // already nudged → not again
  assert.equal(nudgeDue({ ...pc, nudgedAt: 'x' }, now + 26 * 60000), false);
  // not yet expired at 29 min, expired at 31 min
  assert.equal(claimExpired(pc, now + 29 * 60000), false);
  assert.equal(claimExpired(pc, now + 31 * 60000), true);
  assert.equal(minutesLeft(pc, now + 26 * 60000), 4);
});

test('expireClaim removes an overdue claim and returns the dropped person', () => {
  const ev = { id: 'e1', capacity: 1, spotOpenPolicy: 'hold' };
  const rec = normalizeSignups('e1', null);
  const past = Date.now() - 60000;
  rec.pendingClaim = { email: 'c@x.com', name: 'C', claimDeadline: new Date(past).toISOString(), nudgedAt: null };
  const gone = expireClaim(rec, Date.now());
  assert.equal(gone.name, 'C');
  assert.equal(rec.pendingClaim, null);
});

test('credit balance = sum of ledger deltas', () => {
  assert.equal(balanceFromLedger([{ delta: 700 }, { delta: -700 }, { delta: 700 }]), 700);
  assert.equal(normalizeCredit('a@x.com', { ledger: [{ delta: 700 }] }).balanceCents, 700);
  assert.equal(normalizeCredit('a@x.com', null).balanceCents, 0);
});

test('NUDGE_LEAD_MS is 5 min, HOLD_MS is 30 min', () => {
  assert.equal(NUDGE_LEAD_MS, 5 * 60 * 1000);
  assert.equal(HOLD_MS, 30 * 60 * 1000);
});

test('parseTime + eventStartMs parse date/time', () => {
  assert.deepEqual(parseTime('8:30 AM'), { h: 8, m: 30 });
  assert.deepEqual(parseTime('6:30 PM'), { h: 18, m: 30 });
  assert.deepEqual(parseTime('12:00 AM'), { h: 0, m: 0 });
  assert.equal(parseTime('nope'), null);
  const ms = eventStartMs({ date: '2026-06-20', startTime: '8:30 AM' });
  assert.equal(new Date(ms).getHours(), 8);
});

test('isLastDay: true within 24h before start, false otherwise', () => {
  const ev = { date: '2026-06-20', startTime: '8:30 AM' };
  const start = eventStartMs(ev);
  assert.equal(isLastDay(ev, start - 2 * 3600 * 1000), true);
  assert.equal(isLastDay(ev, start - 23 * 3600 * 1000), true);
  assert.equal(isLastDay(ev, start - 30 * 3600 * 1000), false);
  assert.equal(isLastDay(ev, start + 1000), false);
});

test('promoteHead is first-come-first-serve inside 24h (no hold)', () => {
  const ev = { id: 'e1', capacity: 2, feeCents: 700, spotOpenPolicy: 'hold', date: '2026-06-20', startTime: '8:30 AM' };
  const start = eventStartMs(ev);
  const before = start - 48 * 3600 * 1000;
  const rec = normalizeSignups('e1', null);
  addSignup(rec, ev, { name: 'A', email: 'a@x.com' }, before);
  addSignup(rec, ev, { name: 'B', email: 'b@x.com' }, before);
  addSignup(rec, ev, { name: 'C', email: 'c@x.com' }, before); // waitlist
  removeFromRoster(rec, { email: 'a@x.com' });

  const r = promoteHead(rec, ev, start - 2 * 3600 * 1000); // 2h before → FCFS
  assert.deepEqual(r, { fcfs: true });
  assert.equal(rec.pendingClaim, null);
  assert.equal(spotsLeft(ev, rec), 1);   // spot left OPEN
  assert.equal(rec.waitlist.length, 1);  // C not auto-held

  const grabbed = moveWaitlistToRoster(rec, { email: 'c@x.com' });
  assert.equal(grabbed.name, 'C');
  assert.equal(rec.waitlist.length, 0);
  assert.equal(spotsLeft(ev, rec), 0);
});

test('promoteHead still uses a priority hold OUTSIDE the 24h window', () => {
  const ev = { id: 'e1', capacity: 1, feeCents: 700, spotOpenPolicy: 'hold', date: '2026-06-20', startTime: '8:30 AM' };
  const start = eventStartMs(ev);
  const before = start - 72 * 3600 * 1000;
  const rec = normalizeSignups('e1', null);
  addSignup(rec, ev, { name: 'A', email: 'a@x.com' }, before);
  addSignup(rec, ev, { name: 'C', email: 'c@x.com' }, before);
  removeFromRoster(rec, { email: 'a@x.com' });
  const r = promoteHead(rec, ev, before); // 3 days before → hold
  assert.equal(r.name, 'C');
  assert.equal(r.autoClaimed, false);
  assert.ok(rec.pendingClaim);
});
