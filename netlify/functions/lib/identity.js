// netlify/functions/lib/identity.js
//
// Single source of truth for normalizing player contact info so that the same
// human is recognizable across roster edits, teams, and seasons.
//
// A "player" in this app is a roster entry ({ id, name, email, phone, ... })
// embedded in team/<id>.json. There is no global player table, so the only
// durable way to tell whether two roster entries are the same person is to
// compare normalized contact info. These helpers produce that normalized form.
//
// Used by:
//   - captain-roster.js / admin-teams.js  → stamp normalizedEmail/normalizedPhone on save
//   - admin-seed-teams.js                 → stamp them when seeding from registrations
//   - admin-duplicates.js                 → cluster roster entries by these keys
//
// IMPORTANT: a shared phone or email is a STRONG signal that two entries are the
// same person, but NOT proof. Couples and families routinely share a number or
// inbox. Treat a collision as "flag for human confirmation," never as grounds to
// auto-merge or auto-delete. See admin-duplicates.js.

/**
 * Normalize an email for equality comparison.
 * Lowercases and trims. Returns null for empty/invalid input.
 * (We intentionally do NOT strip Gmail dots or +tags — that's an aggressive
 *  normalization that can merge two genuinely different addresses.)
 * @param {*} raw
 * @returns {string|null}
 */
export function normalizeEmail(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // Must look vaguely like an email to be a useful matching key.
  if (!s.includes('@') || s.startsWith('@') || s.endsWith('@')) return null;
  return s;
}

/**
 * Normalize a phone number for equality comparison.
 * Strips all non-digits, then drops a leading US country code so that
 * "+1 (555) 123-4567", "555-123-4567" and "5551234567" all collide.
 * Returns null if fewer than 7 digits remain (too short to be a real number).
 * @param {*} raw
 * @returns {string|null}
 */
export function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D+/g, '');
  if (!digits) return null;
  // Drop a leading US/Canada country code (11 digits starting with 1).
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  if (digits.length < 7) return null;
  return digits;
}

/**
 * Return a roster-entry-shaped object with normalizedEmail/normalizedPhone
 * (re)computed from its raw email/phone. Non-destructive: returns a new object.
 * @param {object} entry roster entry
 * @returns {object}
 */
export function withNormalizedContact(entry) {
  return {
    ...entry,
    normalizedEmail: normalizeEmail(entry?.email),
    normalizedPhone: normalizePhone(entry?.phone),
  };
}

/**
 * Find duplicate contact info WITHIN a single roster (or any list of entries).
 * Returns an array of collision descriptors: { field, value, ids, names }.
 * Each descriptor means "these 2+ entries share this normalized email/phone."
 * @param {object[]} entries roster entries (raw email/phone is fine; normalized here)
 * @returns {{field:'email'|'phone', value:string, ids:string[], names:string[]}[]}
 */
export function findContactCollisions(entries) {
  const byEmail = new Map();
  const byPhone = new Map();

  for (const e of entries || []) {
    const ne = normalizeEmail(e?.email);
    const np = normalizePhone(e?.phone);
    if (ne) {
      if (!byEmail.has(ne)) byEmail.set(ne, []);
      byEmail.get(ne).push(e);
    }
    if (np) {
      if (!byPhone.has(np)) byPhone.set(np, []);
      byPhone.get(np).push(e);
    }
  }

  const collisions = [];
  for (const [value, group] of byEmail) {
    if (group.length > 1) {
      collisions.push({
        field: 'email',
        value,
        ids: group.map(g => g.id).filter(Boolean),
        names: group.map(g => g.name).filter(Boolean),
      });
    }
  }
  for (const [value, group] of byPhone) {
    if (group.length > 1) {
      collisions.push({
        field: 'phone',
        value,
        ids: group.map(g => g.id).filter(Boolean),
        names: group.map(g => g.name).filter(Boolean),
      });
    }
  }
  return collisions;
}
