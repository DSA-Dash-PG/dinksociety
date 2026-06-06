// netlify/functions/lib/rate-limit.js
// Simple sliding-window rate limiter backed by Netlify Blobs.
// Used to stop magic-link spam (filling someone's inbox by hammering
// player-login with their email).
//
// allowRequest('player-login:email:foo@bar.com', { max: 3, windowMin: 15 })
//   → true  = under the limit (this request was counted)
//   → false = over the limit, caller should skip the expensive/abusive action
//
// Fails OPEN on store errors: a blob hiccup should never lock players out
// of signing in. Counters are tiny JSON arrays of timestamps and self-prune.

import { getStore } from '@netlify/blobs';

export async function allowRequest(key, { max = 3, windowMin = 15 } = {}) {
  const store = getStore('rate-limits');
  const blobKey = `rl/${key}.json`;
  const now = Date.now();
  const windowMs = windowMin * 60 * 1000;

  let stamps;
  try {
    stamps = (await store.get(blobKey, { type: 'json' })) || [];
  } catch {
    return true; // fail open
  }

  stamps = stamps.filter((t) => typeof t === 'number' && now - t < windowMs);
  if (stamps.length >= max) {
    console.warn(`[rate-limit] blocked ${key} (${stamps.length}/${max} in ${windowMin}min)`);
    return false;
  }

  stamps.push(now);
  try {
    await store.setJSON(blobKey, stamps);
  } catch {
    // counting failed — still allow; next request re-reads
  }
  return true;
}
