// =============================================================
// /api/admin-link  (magic-link callback WITH A CONFIRM STEP)
//
//   GET  ?token=xxx  → render a "Confirm sign-in" page. Does NOT consume the
//                      token, so an email scanner's prefetch (Microsoft Safe
//                      Links, etc.) can't burn the one-time link before the human.
//   POST (token in the form body) → consume the token, create the admin session,
//                      set the cookie, redirect to /admin.html.
//
// On failure, redirects to /admin.html?error=<reason>. Scanners GET links but
// don't submit forms, so only a real button click consumes the token.
// =============================================================

import { getStore } from '@netlify/blobs';
import crypto from 'crypto';
import { recordLogin } from './lib/activity-log.js';

function confirmPage(token) {
  const t = String(token || '').replace(/[^a-f0-9]/g, '').slice(0, 64); // admin token = 64 hex
  return `<!DOCTYPE html><html lang="en" data-theme="dark"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm admin sign-in · The Dink Society</title><meta name="robots" content="noindex,nofollow">
<style>
:root{--bg:#0e0e0e;--surface:#161616;--border:rgba(255,255,255,.08);--text:#f0f0ec;--muted:#9a9e97;--faint:#5e625c;--lime:#b8ff2c;--teal:#17d7b0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;-webkit-font-smoothing:antialiased}
.card{max-width:400px;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:38px 30px;text-align:center}
.logo{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
.tag{font-size:9px;letter-spacing:.2em;text-transform:uppercase;color:var(--teal);font-weight:700;margin-bottom:22px}
h1{font-size:22px;font-weight:800;text-transform:uppercase;margin-bottom:8px;line-height:1.1}
p{font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:22px;max-width:32ch;margin-left:auto;margin-right:auto}
button{width:100%;min-height:48px;border:none;border-radius:9999px;background:var(--lime);color:#0e0e0e;font:inherit;font-weight:800;font-size:14px;cursor:pointer;transition:filter .15s}
button:hover{filter:brightness(1.06)}
.foot{font-size:11px;color:var(--faint);margin-top:16px;line-height:1.5}
</style></head><body>
<div class="card">
  <div class="logo">The Dink Society</div><div class="tag">Admin</div>
  <h1>Confirm sign-in</h1>
  <p>You're one tap away from the admin portal. Click below to finish signing in on this device.</p>
  <form method="POST" action="/.netlify/functions/admin-link">
    <input type="hidden" name="token" value="${t}">
    <button type="submit">Sign me in</button>
  </form>
  <div class="foot">This link is single-use and expires in 15 minutes. If it says expired, request a fresh one.</div>
</div></body></html>`;
}
const htmlResponse = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const url = new URL(req.url);
  const redirectBase = '/admin.html';
  const redirect = (p) => Response.redirect(new URL(p, url.origin), 302);

  // ── Step 1: GET → confirm page. Never consumes the token. ──
  if (req.method === 'GET') {
    const token = url.searchParams.get('token');
    if (!token) return redirect(`${redirectBase}?error=missing`);
    return htmlResponse(confirmPage(token));
  }

  // ── Step 2: POST (the button) → consume + sign in. ──
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let token = null;
  try { const form = await req.formData(); token = form.get('token'); }
  catch { token = url.searchParams.get('token'); }
  if (!token) return redirect(`${redirectBase}?error=missing`);

  try {
    const store = getStore('admin-magic-links');
    const raw = await store.get(token);
    if (!raw) return redirect(`${redirectBase}?error=invalid`);

    const record = JSON.parse(raw);
    if (Date.now() > record.expiresAt) { await store.delete(token); return redirect(`${redirectBase}?error=expired`); }
    if (record.used) return redirect(`${redirectBase}?error=invalid`);

    // Mark used only now, on the real click.
    await store.set(token, JSON.stringify({ ...record, used: true }));

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpiry = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    await getStore('admin-sessions').set(sessionToken, JSON.stringify({ email: record.email, expiresAt: sessionExpiry }));

    await recordLogin({ email: record.email, role: 'admin' });

    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const cookie = [
      `admin_session=${sessionToken}`, 'Path=/', 'HttpOnly',
      `Max-Age=${24 * 60 * 60}`, 'SameSite=Lax', ...(isLocal ? [] : ['Secure']),
    ].join('; ');

    // Land on the unified admin console (league + ladders in one shell). The
    // standalone /admin.html still works if visited directly. Error paths above
    // stay on /admin.html so the login form can surface the message.
    return new Response(null, { status: 302, headers: { Location: '/console.html', 'Set-Cookie': cookie } });
  } catch (err) {
    console.error('admin-link error:', err);
    return redirect(`${redirectBase}?error=server`);
  }
};
