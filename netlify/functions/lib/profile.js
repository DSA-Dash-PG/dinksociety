// netlify/functions/lib/profile.js
//
// Shared helpers for player profile bio fields (height, dob, plays, city,
// homeCourt) and the admin-approval workflow that gates them.
//
// PRIVACY: `dob` (date of birth) is sensitive and must NEVER be emitted by a
// public endpoint. Use ageFromDob() to expose a computed age instead.
//
// Approval model (stored on the roster entry inside the `teams` blob):
//   profile        : { height, dob, plays, city, homeCourt }   ← LIVE / approved
//   pendingProfile : { ...changedFields, photo?, submittedBy, submittedAt } ← awaiting admin
//   photo          : { updatedAt, contentType }                ← LIVE approved photo stamp
// A player/captain edit writes pendingProfile; an admin approve copies it into
// profile/photo and clears pendingProfile. An admin's own edit writes profile
// directly (admins are the approvers).

export const PROFILE_FIELDS = ['height', 'dob', 'plays', 'city', 'homeCourt'];

const PLAYS_VALUES = new Set(['Right', 'Left', 'Both']);

// Compute current age in whole years from a YYYY-MM-DD date of birth.
// Returns null for missing/invalid input. Never returns the DOB itself.
export function ageFromDob(dob) {
  if (!dob || typeof dob !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const birth = new Date(Date.UTC(y, mo - 1, d));
  if (isNaN(birth) || birth.getUTCFullYear() !== y || birth.getUTCMonth() !== mo - 1 || birth.getUTCDate() !== d) {
    return null;
  }
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  if (age < 0 || age > 120) return null;
  return age;
}

// Validate + normalize an incoming profile patch. Only known keys are kept.
// Returns { profile, error }. An empty string clears a field. Keys that are
// absent are left untouched by the caller (this only validates supplied keys).
export function cleanProfileInput(input) {
  if (!input || typeof input !== 'object') return { profile: {}, error: null };
  const out = {};

  if ('height' in input) {
    out.height = String(input.height ?? '').trim().slice(0, 16);
  }
  if ('dob' in input) {
    const raw = String(input.dob ?? '').trim();
    if (raw === '') {
      out.dob = '';
    } else {
      const age = ageFromDob(raw);
      if (age == null) return { profile: {}, error: 'Date of birth must be a valid date (YYYY-MM-DD).' };
      if (age < 5) return { profile: {}, error: 'Date of birth looks too recent.' };
      out.dob = raw;
    }
  }
  if ('plays' in input) {
    const raw = String(input.plays ?? '').trim();
    if (raw === '') out.plays = '';
    else if (PLAYS_VALUES.has(raw)) out.plays = raw;
    else return { profile: {}, error: 'Plays must be Right, Left, or Both.' };
  }
  if ('city' in input) {
    out.city = String(input.city ?? '').trim().slice(0, 60);
  }
  if ('homeCourt' in input) {
    out.homeCourt = String(input.homeCourt ?? '').trim().slice(0, 80);
  }

  return { profile: out, error: null };
}

// Public-safe view of a roster entry's approved profile: computed age, no DOB.
export function publicProfile(rosterEntry) {
  const p = rosterEntry?.profile || {};
  return {
    height: p.height || null,
    plays: p.plays || null,
    city: p.city || null,
    homeCourt: p.homeCourt || null,
    age: ageFromDob(p.dob),
  };
}
