// netlify/functions/lib/owner.js
// The single "owner" account — a super-admin who can do owner-only things (e.g.
// impersonate any player). Distinct from the general admin list (ADMIN_EMAILS):
// other admins are admins but NOT the owner.
//
// Configurable via PORTAL_OWNER_EMAIL in Netlify; defaults to Richard's account.

import { requireAdmin } from './admin-auth.js';

const DEFAULT_OWNER = 'richardhak@gmail.com';

export function ownerEmail() {
  const env = (typeof Netlify !== 'undefined' && Netlify.env.get('PORTAL_OWNER_EMAIL')) || process.env.PORTAL_OWNER_EMAIL;
  return String(env || DEFAULT_OWNER).trim().toLowerCase();
}

export function isOwnerEmail(email) {
  return String(email || '').trim().toLowerCase() === ownerEmail();
}

/** Require a valid admin session that is ALSO the owner. Returns { email } or null. */
export async function requireOwner(req) {
  let admin;
  try { admin = await requireAdmin(req); } catch { return null; }
  return (admin && isOwnerEmail(admin.email)) ? admin : null;
}
