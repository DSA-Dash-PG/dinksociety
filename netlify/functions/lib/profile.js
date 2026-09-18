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
import { createApprovalLinks } from './approval-token.js';

export const PROFILE_FIELDS = ['height', 'dob', 'plays', 'city', 'homeCourt'];

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.app';
}

const FIELD_LABELS = { height: 'Height', dob: 'Date of birth', plays: 'Plays', city: 'City', homeCourt: 'Home court' };

function initials(name) {
  return String(name || '?').replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
}

function avatarCell(label, imgUrl, name) {
  const inner = imgUrl
    ? `<img src="${escAttr(imgUrl)}" width="112" height="112" alt="${escAttr(label)}" style="width:112px;height:112px;border-radius:50%;object-fit:cover;display:block;border:2px solid #2a2a2a;">`
    : `<div style="width:112px;height:112px;border-radius:50%;background:#1c1c1c;border:2px solid #2a2a2a;color:#b8ff2c;font-weight:800;font-size:30px;line-height:112px;text-align:center;">${escAttr(initials(name))}</div>`;
  return `<td style="padding:0 10px;text-align:center;vertical-align:top;">
      <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin-bottom:8px;">${escAttr(label)}</div>
      ${inner}
    </td>`;
}

/**
 * Email every league admin that a profile change is waiting for approval — and
 * SHOW them the change (current → proposed fields, current → new photo) with
 * one-tap Approve / Deny links so nothing needs a sign-in.
 *
 * Best-effort: never throws (callers await inside try/catch and ignore errors)
 * so a mail hiccup can't fail the player's/captain's save.
 *
 * @param {{ playerName:string, teamName:string, submittedBy:string, what:string,
 *           teamId?:string|null, playerId?:string,
 *           entry?: { profile?:object, pendingProfile?:object, photo?:object } }} o
 *   `entry` is the roster entry (or lite player record) AFTER the pending
 *   change was written. Without `playerId`/`entry` the email falls back to a
 *   plain "open the admin panel" notice.
 */
export async function notifyAdminsPendingProfile({ playerName, teamName, submittedBy, what, teamId = null, playerId = null, entry = null }) {
  try {
    const to = adminEmailList();
    if (!to.length) return;
    const who = submittedBy === 'captain' ? 'their captain' : 'the player';
    const base = siteUrl();
    const adminUrl = `${base}/admin.html`;
    const pp = entry?.pendingProfile || null;

    // One-tap links — only when we know which record to act on.
    let links = null;
    if (playerId && pp) {
      try {
        links = await createApprovalLinks({ kind: 'profile', teamId, playerId });
      } catch (e) {
        console.error('notifyAdminsPendingProfile: token create failed (falling back to panel link):', e?.message || e);
      }
    }
    const approveUrl = links ? `${base}/.netlify/functions/approval-decide?t=${links.approve}` : null;
    const denyUrl = links ? `${base}/.netlify/functions/approval-decide?t=${links.reject}` : null;

    // ── What changed ──
    let changesHtml = '';
    if (pp) {
      const rows = [];
      for (const f of PROFILE_FIELDS) {
        if (!(f in pp)) continue;
        const cur = (entry.profile || {})[f];
        const next = pp[f];
        const curTxt = cur ? escAttr(cur) : '<span style="color:#666;">&mdash;</span>';
        const nextTxt = (next === '' || next == null) ? '<span style="color:#ff9d8f;">(cleared)</span>' : `<b style="color:#fff;">${escAttr(next)}</b>`;
        rows.push(`<tr>
          <td style="padding:8px 10px;font-size:12px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;font-weight:700;border-top:1px solid #222;white-space:nowrap;">${FIELD_LABELS[f] || f}</td>
          <td style="padding:8px 10px;font-size:14px;color:#cfcfcf;border-top:1px solid #222;">${curTxt}</td>
          <td style="padding:8px 6px;font-size:14px;color:#666;border-top:1px solid #222;">&rarr;</td>
          <td style="padding:8px 10px;font-size:14px;color:#f5f5f5;border-top:1px solid #222;">${nextTxt}</td>
        </tr>`);
      }
      if (rows.length) {
        changesHtml += `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#161616;border-radius:8px;margin:0 0 18px;">
          <tr><td style="padding:8px 10px;font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;"></td>
              <td style="padding:8px 10px;font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Now</td><td></td>
              <td style="padding:8px 10px;font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;">Proposed</td></tr>
          ${rows.join('')}
        </table>`;
      }
      if (pp.photo && playerId) {
        const curUrl = entry.photo?.updatedAt
          ? `${base}/.netlify/functions/player-photo-serve?id=${encodeURIComponent(playerId)}&v=${encodeURIComponent(entry.photo.updatedAt)}`
          : null;
        const newUrl = links
          ? `${base}/.netlify/functions/player-photo-serve?id=${encodeURIComponent(playerId)}&pending=1&t=${links.view}&v=${encodeURIComponent(pp.photo.updatedAt || '')}`
          : null;
        changesHtml += `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 18px;">
          <tr>${avatarCell('Current photo', curUrl, playerName)}<td style="color:#666;font-size:22px;vertical-align:middle;">&rarr;</td>${avatarCell('New photo', newUrl, playerName)}</tr>
        </table>`;
        if (!newUrl) changesHtml += `<p style="font-size:13px;color:#8a8a8a;margin:0 0 18px;">Preview the new photo in the admin panel.</p>`;
      }
    }

    const buttons = approveUrl
      ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 14px;"><tr>
          <td style="padding-right:6px;width:50%;"><a href="${approveUrl}" style="display:block;text-align:center;padding:14px 10px;background:#b8ff2c;color:#0e0e0e;font-size:15px;font-weight:800;text-decoration:none;border-radius:9999px;">&#10003; Approve</a></td>
          <td style="padding-left:6px;width:50%;"><a href="${denyUrl}" style="display:block;text-align:center;padding:13px 10px;background:transparent;color:#ff5c47;font-size:15px;font-weight:800;text-decoration:none;border:1px solid rgba(255,92,71,0.45);border-radius:9999px;">&#10005; Deny</a></td>
        </tr></table>
        <p style="font-size:12px;color:#777;line-height:1.5;margin:0 0 18px;">One tap does it — no sign-in. Links are single-use and expire in 14 days. <a href="${adminUrl}" style="color:#9a9e97;">Open admin panel</a> instead.</p>`
      : `<p style="margin:0 0 18px;"><a href="${adminUrl}" style="background:#b8ff2c;color:#0a0f08;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:9999px;display:inline-block;font-size:14px;">Open admin panel</a></p>`;

    const html = `<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:36px 20px;background:#0e0e0e;color:#f5f5f5;">
      <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#f5f5f5;margin-bottom:24px;">THE DINK SOCIETY</div>
      <h1 style="font-size:22px;font-weight:800;color:#f5f5f5;margin:0 0 12px;line-height:1.25;">Profile change awaiting approval</h1>
      <p style="font-size:15px;color:#cfcfcf;line-height:1.6;margin:0 0 18px;"><b style="color:#fff;">${escAttr(playerName)}</b> (${escAttr(teamName)}) has a ${escAttr(what)} submitted by ${who}.</p>
      ${changesHtml}
      ${buttons}
      <div style="margin-top:28px;padding-top:16px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">The Dink Society &middot; sent to league admins</div>
    </div>`;

    await sendEmail({
      to,
      subject: `Profile approval needed \u2014 ${playerName} (${teamName})`,
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
