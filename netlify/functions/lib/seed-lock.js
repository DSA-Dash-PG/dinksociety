// netlify/functions/lib/seed-lock.js
//
// Lightweight blob-backed cooldown guard for destructive/expensive admin
// operations (seed + wipe). It prevents an admin from accidentally hammering
// these endpoints (double-click, retries) within a short window.
//
// This is a cooldown, not a hard mutex — it records the last run time per
// operation and rejects re-runs that arrive inside the cooldown window. Good
// enough to stop accidental rapid reruns without adding heavyweight locking.

import { getStore } from '@netlify/blobs';

const STORE = 'seed-locks';
const DEFAULT_COOLDOWN_MS = 15000; // 15s

/**
 * Returns { ok: true } if the operation may proceed (and records the run),
 * or { ok: false, retryInMs } if it ran too recently.
 *
 * Fails open: if the lock store is unavailable, the operation is allowed.
 */
export async function guardSeedRun(op, cooldownMs = DEFAULT_COOLDOWN_MS) {
  try {
    const store = getStore({ name: STORE, consistency: 'strong' });
    const key = `lock/${op}.json`;
    const now = Date.now();
    const prev = await store.get(key, { type: 'json' }).catch(() => null);
    if (prev && typeof prev.at === 'number' && (now - prev.at) < cooldownMs) {
      return { ok: false, retryInMs: cooldownMs - (now - prev.at) };
    }
    await store.setJSON(key, { at: now, op }).catch(() => {});
    return { ok: true };
  } catch {
    return { ok: true };
  }
}
