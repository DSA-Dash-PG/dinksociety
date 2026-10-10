// netlify/functions/lib/roster-email.js
//
// Where to reach a rostered player, and which roster entries are the same human.
//
// A roster entry's address can sit in `normalizedEmail`, in raw `email`, or
// nowhere at all: players added to a Season 2 team through the picker carry no
// address of their own, only the one on their Season 1 entry. Reading just
// `p.email` is how the first Season 2 Drop went out to nobody. This is the one
// lookup for "this entry's address": the entry's own fields first, then any
// other entry the identity layer (lib/league-identity.js) says is the same
// person. Used by the game-night recap and the availability reminders;
// admin-drop.js resolveRecipients follows the same rule.

import { normalizeEmail } from './identity.js';
import { listRosterEntries, getIdentityMap, groupEntries } from './league-identity.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Load the roster + identity map once and hand back two lookups:
 *   emailOf(rosterEntry, playerId) → address or null
 *   personOf(playerId)             → one id per human (for de-duping sends)
 * Never throws: if the identity lookup fails it falls back to the entry's own
 * address, which is what every caller did before.
 */
export async function rosterEmailResolver() {
  const emailById = new Map();
  let personOf = (id) => id, idsFor = (id) => [id];
  try {
    const [entries, map] = await Promise.all([listRosterEntries(), getIdentityMap()]);
    for (const e of entries) {
      const em = e.normalizedEmail || normalizeEmail(e.email);
      if (em && EMAIL_RE.test(em)) emailById.set(e.id, em);
    }
    const { canonicalOf, membersOf } = groupEntries(entries, map);
    personOf = (id) => canonicalOf[id] || id;
    idsFor = (id) => { const c = canonicalOf[id]; return c ? (membersOf[c] || [id]) : [id]; };
  } catch (e) {
    console.error('[roster-email] identity lookup failed, using roster emails only:', e?.message || e);
  }
  const emailOf = (rosterEntry, playerId = rosterEntry?.id) => {
    const direct = rosterEntry && (rosterEntry.normalizedEmail || normalizeEmail(rosterEntry.email));
    if (direct && EMAIL_RE.test(direct)) return direct;
    for (const id of idsFor(playerId)) { const em = emailById.get(id); if (em) return em; }
    return null;
  };
  return { personOf, emailOf };
}
