// netlify/functions/lib/retry.js
// Retry wrapper for transient blob-store hiccups (momentary network/DB
// failures, ~1–2x/month on hobby tiers).
//
// READ OPERATIONS ONLY. Never wrap writes (setJSON/set/delete) — a write
// that "failed" may have actually landed, and blindly retrying can
// double-apply it. Reads are idempotent, so retrying is always safe.

/**
 * Run a read operation, retrying on failure.
 * Defaults: 2 retries, 300ms delay between attempts (3 attempts total).
 */
export async function withRetry(fn, { retries = 2, delayMs = 300, label = 'read' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.warn(`[retry] ${label} failed (attempt ${attempt + 1}/${retries + 1}): ${err?.message || err} — retrying in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * store.get(key, { type: 'json' }) with retry.
 * Note: a missing key resolves to null (no throw), so retries only fire on
 * actual transport/store errors — not on "not found".
 */
export function getJSON(store, key) {
  return withRetry(() => store.get(key, { type: 'json' }), { label: `get ${key}` });
}

/** store.get(key) (raw string) with retry. */
export function getRaw(store, key) {
  return withRetry(() => store.get(key), { label: `get ${key}` });
}

/** store.list(opts) with retry. */
export function listWithRetry(store, opts) {
  return withRetry(() => store.list(opts), { label: `list ${opts?.prefix || ''}` });
}
