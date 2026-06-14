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

import { sendEmail } from './email.js';
import { adminEmailList } from './admin-auth.js';

export const PROFILE_FIELDS = ['height', 'dob', 'plays', 'city', 'homeCourt'];

// Email every league admin that a profile change is waiting for approval.
// Best-effort: never throws (callers await inside try/catch and ignore errors)
// so a mail hiccup can't fail the player's/captain's save.
export async function notifyAdminsPendingProfile({ playerName, teamName, submittedBy, what }) {
  try {
    const to = adminEmailList();
    if (!to.length) return;
    const who = submittedBy === 'captain' ? 'their captain' : 'the player';
    const adminUrl = 'https://dinksociety.app/admin.html';
    const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
      <h2 style="font-size:18px;margin:0 0 12px;">Profile change awaiting approval</h2>
      <p style="font-size:14px;line-height:1.6;margin:0 0 8px;">
        <b>${escAttr(playerName)}</b> (${escAttr(teamName)}) has a ${escAttr(what)} submitted by ${who} and waiting for review.
      </p>
      <p style="font-size:14px;line-height:1.6;margin:0 0 18px;">Approve or reject it in the <b>Profile Approvals</b> tab.</p>
      <p style="margin:0;"><a href="${adminUrl}" style="background:#b8ff2c;color:#0a0f08;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px;display:inline-block;font-size:14px;">Open admin panel</a></p>
    </div>`;
    await sendEmail({
      to,
      subject: `Profile approval needed — ${playerName} (${teamName})`,
      html,
    });
  } catch (err) {
    console.error('notifyAdminsPendingProfile failed (non-fatal):', err?.message || err);
  }
}

function escAttr(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const PLAYS_VALUES = new Set(['Right Handed', 'Left Handed', 'Both']);

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
    else return { profile: {}, error: 'Plays must be Right Handed, Left Handed, or Both.' };
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
