// netlify/functions/player-link.js
// Magic-link callback WITH A CONFIRM STEP, so email security scanners (Microsoft
// Safe Links, Gmail/Proofpoint prefetch, antivirus, etc.) that GET every link in
// incoming mail can't burn the one-time token before the human clicks.
//
//   GET  ?token=…   → render a "Confirm sign-in" page. Does NOT consume the token,
//                     so a scanner's prefetch leaves it valid for the real person.
//   POST (token in the form body) → consume the token, set the session cookie,
//                     redirect to /me.html (or a validated same-site ?next= path).
//
// Scanners fetch URLs (GET) but do not submit HTML forms, so only a genuine click
// on the button consumes the token. Previously the GET consumed it immediately,
// which is why scanned inboxes always saw "invalid or already used."

import { consumePlayerToken, createPlayerSession, buildPlayerCookie } from './lib/player-auth.js';
import { getStore } from '@netlify/blobs';
import { recordLogin } from './lib/activity-log.js';

function siteUrlOf() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL')) || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

// Only a same-site absolute path is allowed as a post-login destination
// (blocks open-redirects like //evil.com or https://evil.com).
function safeNext(raw) {
  const s = String(raw || '');
  return (/^\/[A-Za-z0-9._~\-\/?=&%#]*$/.test(s) && !s.startsWith('//')) ? s : '/me.html';
}

function confirmPage(token, next) {
  const t = String(token || '').replace(/[^a-f0-9]/g, '').slice(0, 48); // token = 48 lowercase hex
  const n = safeNext(next).replace(/"/g, '&quot;');
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
  <div class="logo">The Dink Society</div><div class="tag">Player Portal</div>
  <h1>Confirm sign-in</h1>
  <p>You're one tap away. Click below to finish signing in on this device.</p>
  <form method="POST" action="/.netlify/functions/player-link">
    <input type="hidden" name="token" value="${t}">
    <input type="hidden" name="next" value="${n}">
    <button type="submit">Sign me in</button>
  </form>
  <div class="foot">This link is single-use and expires shortly. If it says expired, request a fresh one from the sign-in page.</div>
</div></body></html>`;
}

const htmlResponse = (body) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default async (req) => {
  const url = new URL(req.url);
  const siteUrl = siteUrlOf();
  const redirect = (path) => new Response(null, { status: 302, headers: { Location: new URL(path, siteUrl).toString() } });

  // ── Step 1: GET → confirm page. Never consumes the token. ──
  if (req.method === 'GET') {
    const token = url.searchParams.get('token');
    if (!token) return redirect('/me.html?error=missing');
    return htmlResponse(confirmPage(token, url.searchParams.get('next')));
  }

  // ── Step 2: POST (the button) → consume the token + create the session. ──
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let token = null, next = '/me.html';
  try {
    const form = await req.formData();
    token = form.get('token');
    next = safeNext(form.get('next'));
  } catch {
    token = url.searchParams.get('token');
    next = safeNext(url.searchParams.get('next'));
  }
  if (!token) return redirect('/me.html?error=missing');

  try {
    const consumed = await consumePlayerToken(token);
    if (!consumed) return redirect('/me.html?error=invalid');
    const sessionId = await createPlayerSession({ playerId: consumed.playerId, teamId: consumed.teamId, email: consumed.email });

    // Activity log: who's actually using the site (never throws, test teams skipped).
    // Lite ladder-only accounts have no team (teamId null) — skip the team lookup.
    const team = consumed.teamId ? await getStore('teams').get(`team/${consumed.teamId}.json`, { type: 'json' }).catch(() => null) : null;
    const rosterEntry = (team?.roster || []).find(p => p.id === consumed.playerId);
    await recordLogin({ email: consumed.email, role: 'player', name: rosterEntry?.name || null, team, playerId: consumed.playerId });

    return new Response(null, {
      status: 302,
      headers: { Location: new URL(next, siteUrl).toString(), 'Set-Cookie': buildPlayerCookie(sessionId) },
    });
  } catch (err) {
    console.error('player-link error:', err);
    return redirect('/me.html?error=server');
  }
};

export const config = { path: '/.netlify/functions/player-link' };
