// netlify/functions/captain-link.js
// Magic-link callback WITH A CONFIRM STEP so email link-scanners (Microsoft Safe
// Links, etc.) that GET every link can't burn the one-time token before the human.
//
//   GET  ?token=…  → render a "Confirm sign-in" page. Does NOT consume the token.
//   POST (token in the form body) → consume, load the captain's team, create the
//                 session, set the cookie, redirect to /captain.html.
//
// Scanners fetch URLs (GET) but don't submit forms, so only a real click signs in.

import {
  consumeMagicToken,
  createSession,
  buildCaptainCookie,
  getTeamById,
} from './lib/captain-auth.js';
import { recordLogin } from './lib/activity-log.js';

function confirmPage(token) {
  const t = String(token || '').replace(/[^a-f0-9]/g, '').slice(0, 64);
  return `<!DOCTYPE html><html lang="en" data-theme="dark"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Confirm sign-in · The Dink Society</title><meta name="robots" content="noindex,nofollow">
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
  <div class="logo">The Dink Society</div><div class="tag">Captain Portal</div>
  <h1>Confirm sign-in</h1>
  <p>You're one tap away. Click below to finish signing in on this device.</p>
  <form method="POST" action="/.netlify/functions/captain-link">
    <input type="hidden" name="token" value="${t}">
    <button type="submit">Sign me in</button>
  </form>
  <div class="foot">This link is single-use and expires shortly. If it says expired, request a fresh one.</div>
</div></body></html>`;
}
const htmlResponse = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const url = new URL(req.url);
  const siteUrl = Netlify.env.get('SITE_URL') || 'https://dinksociety.netlify.app';
  const redirect = (path) => new Response(null, { status: 302, headers: { Location: new URL(path, siteUrl).toString() } });

  // ── Step 1: GET → confirm page. Never consumes the token. ──
  if (req.method === 'GET') {
    const token = url.searchParams.get('token');
    if (!token) return redirect('/captain.html?error=missing');
    return htmlResponse(confirmPage(token));
  }

  // ── Step 2: POST (the button) → consume + sign in. ──
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let token = null;
  try { const form = await req.formData(); token = form.get('token'); }
  catch { token = url.searchParams.get('token'); }
  if (!token) return redirect('/captain.html?error=missing');

  try {
    const consumed = await consumeMagicToken(token);
    if (!consumed) return redirect('/captain.html?error=invalid');

    // The magic token carries the captain's team — load it.
    const team = await getTeamById(consumed.teamId);
    if (!team) return redirect('/captain.html?error=expired');

    const sessionId = await createSession(team, consumed.email);

    // Activity log (never throws, test teams skipped)
    const rosterEntry = (team.roster || []).find(p =>
      (p.normalizedEmail || (p.email || '').toLowerCase()) === consumed.email.toLowerCase());
    await recordLogin({ email: consumed.email, role: 'captain', name: rosterEntry?.name || null, team, playerId: rosterEntry?.id || null });

    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL('/captain.html', siteUrl).toString(),
        'Set-Cookie': buildCaptainCookie(sessionId),
      },
    });
  } catch (err) {
    console.error('captain-link error:', err);
    return redirect('/captain.html?error=server');
  }
};

export const config = { path: '/.netlify/functions/captain-link' };
