// netlify/functions/admin-preview-as.js
// OWNER-ONLY full impersonation: lets the owner sign in AS any player (league
// roster OR lite ladder account) to see and use the app exactly as they do.
// Server-enforced — only the owner email (lib/owner.js) gets through; any other
// admin gets 403 even if they hit this URL directly.
//
//   POST { email }  → resolves the player by email, mints a 4-hour player session
//                     + a JS-readable ds_view_as cookie for the "viewing as" banner.
//                     → { ok, redirect:'/me.html', viewAs }

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import { isOwnerEmail } from './lib/owner.js';
import { findPlayerByEmail } from './lib/player-auth.js';
import { normalizeEmail } from './lib/identity.js';

const HOURS = 4;

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } }); }
function cookie(name, value, maxAge, httpOnly) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (httpOnly) parts.splice(1, 0, 'HttpOnly');
  return parts.join('; ');
}
function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Must be a signed-in admin AND the owner — both checked server-side.
  let admin;
  try { admin = await requireAdmin(req); } catch { return unauthResponse(); }
  if (!isOwnerEmail(admin.email)) return json({ error: 'Owner only — you are not authorized to impersonate players.' }, 403);

  const body = await req.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'A valid player email is required.' }, 400);

  // Resolve to a real account (team roster first, then lite ladder account).
  const found = await findPlayerByEmail(email);
  if (!found || !found.playerId) return json({ error: 'No player account found for that email.' }, 404);

  const now = Date.now();
  const sessionId = randomId(20);
  await getStore('player-sessions').setJSON(`session/${sessionId}.json`, {
    id: sessionId,
    playerId: found.playerId,
    teamId: found.teamId || null,
    email,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + HOURS * 60 * 60 * 1000).toISOString(),
    impersonatedBy: admin.email, // audit trail (guards ignore extra fields)
  });

  const maxAge = HOURS * 60 * 60;
  const viewAs = { name: found.name || email, by: admin.email };
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', cookie('ds_player_session', sessionId, maxAge, true));
  // JS-readable so the portal can show the "viewing as" banner.
  headers.append('Set-Cookie', cookie('ds_view_as', encodeURIComponent(JSON.stringify(viewAs)), maxAge, false));
  console.log(`[preview-as] ${admin.email} → player "${viewAs.name}" (${email})`);
  return new Response(JSON.stringify({ ok: true, redirect: '/me.html', viewAs }), { status: 200, headers });
};

export const config = { path: '/.netlify/functions/admin-preview-as' };
