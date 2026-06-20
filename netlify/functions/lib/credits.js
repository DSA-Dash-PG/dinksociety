// netlify/functions/lib/credits.js
//
// Ladder credit — issued when a player cancels a paid spot (no refunds, so no
// money ever moves). One ledger per person, keyed by NORMALIZED EMAIL so the
// balance follows the same human across ladders/seasons (same identity rule as
// lib/identity.js). Strong consistency so two concurrent spends can't both win.
//
//   ladder-credits  credit/<normalizedEmail>.json
//   { email, balanceCents, ledger: [ { id, ts, delta, type, reason, eventId, key? } ], updatedAt }
//
// Money is always integer CENTS. `balanceCents` is a cache of sum(ledger.delta)
// and is recomputed on every write, so it can't drift.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';

const STORE = 'ladder-credits';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }
const keyFor = (norm) => `credit/${norm}.json`;

// ── pure helpers (unit-tested) ──

/** Balance = sum of every ledger delta (the source of truth). */
export function balanceFromLedger(ledger) {
  return (Array.isArray(ledger) ? ledger : []).reduce((s, e) => s + (Number(e.delta) || 0), 0);
}

/** Normalize a raw credit record into a safe shape. */
export function normalizeCredit(email, rec) {
  const ledger = Array.isArray(rec?.ledger) ? rec.ledger : [];
  return { email: rec?.email || email || null, ledger, balanceCents: balanceFromLedger(ledger), updatedAt: rec?.updatedAt || null };
}

function entry({ delta, type, reason, eventId, key }) {
  return {
    id: randomId(8),
    ts: new Date().toISOString(),
    delta: Math.round(Number(delta) || 0),
    type,                 // 'earned' | 'spent' | 'adjustment' | 'expired'
    reason: String(reason || '').slice(0, 200),
    eventId: eventId || null,
    ...(key ? { key } : {}),
  };
}

// ── storage ──

export async function getCredit(email) {
  const norm = normalizeEmail(email);
  if (!norm) return normalizeCredit(email, null);
  const rec = await store().get(keyFor(norm), { type: 'json' }).catch(() => null);
  return normalizeCredit(norm, rec);
}

export async function getBalanceCents(email) {
  return (await getCredit(email)).balanceCents;
}

/**
 * Append a ledger entry and recompute the balance. If `key` is given and an
 * entry with that key already exists, this is a no-op (idempotent) — so a retry
 * can't double-credit. Returns the updated record.
 */
async function append(email, e) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error('valid email required for credit');
  const rec = await getCredit(norm);
  if (e.key && rec.ledger.some(x => x.key === e.key)) return rec; // idempotent
  const ledger = [e, ...rec.ledger];
  const updated = { email: norm, ledger, balanceCents: balanceFromLedger(ledger), updatedAt: new Date().toISOString() };
  await store().setJSON(keyFor(norm), updated);
  return updated;
}

/** Credit a player (e.g. on cancellation). `key` makes it idempotent. */
export function earn(email, cents, reason, { eventId, key } = {}) {
  return append(email, entry({ delta: Math.abs(Math.round(cents)), type: 'earned', reason, eventId, key }));
}

/**
 * Spend credit (e.g. applied to a signup). Throws if the balance is too low.
 * Returns the updated record.
 */
export async function spend(email, cents, reason, { eventId, key } = {}) {
  const amount = Math.abs(Math.round(cents));
  const rec = await getCredit(email);
  if (rec.balanceCents < amount) throw new Error('insufficient ladder credit');
  return append(email, entry({ delta: -amount, type: 'spent', reason, eventId, key }));
}

/** Manual admin correction (positive or negative). */
export function adjust(email, cents, reason, { eventId, key } = {}) {
  return append(email, entry({ delta: Math.round(cents), type: 'adjustment', reason, eventId, key }));
}

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
