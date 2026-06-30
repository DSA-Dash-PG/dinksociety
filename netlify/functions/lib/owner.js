// netlify/functions/lib/owner.js
// The single "owner" account — a super-admin who can do owner-only things (e.g.
// impersonate any player). Distinct from the general admin list (ADMIN_EMAILS):
// other admins are admins but NOT the owner.
//
// Set via PORTAL_OWNER_EMAIL in Netlify. The email is intentionally NOT hardcoded
// here: a literal that equals an env-var value trips Netlify's secret scanner and
// fails the build. If the var is unset, ownerEmail() returns '' and owner-only
// features stay locked (safe default).

import { requireAdmin } from './admin-auth.js';

export function ownerEmail() {
  const env = (typeof Netlify !== 'undefined' && Netlify.env.get('PORTAL_OWNER_EMAIL')) || process.env.PORTAL_OWNER_EMAIL;
  return String(env || '').trim().toLowerCase();
}

export function isOwnerEmail(email) {
  const owner = ownerEmail();
  if (!owner) return false; // no owner configured → nobody is the owner
  return String(email || '').trim().toLowerCase() === owner;
}

/** Require a valid admin session that is ALSO the owner. Returns { email } or null. */
export async function requireOwner(req) {
  let admin;
  try { admin = await requireAdmin(req); } catch { return null; }
  return (admin && isOwnerEmail(admin.email)) ? admin : null;
}
