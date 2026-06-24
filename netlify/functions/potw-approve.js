// netlify/functions/potw-approve.js
// One-tap approval endpoint for the weekly K'CHN Player of the Week emails.
//
// Two-step on purpose:
//   GET  ?t=<token>  → peek the token (does NOT consume) and render a confirm
//                      page with a real "Approve & send now" button. This means
//                      an email-client link prefetch / scanner cannot fire a
//                      send by merely opening the link.
//   POST (form, t=<token>) → consume the token (single-use) and send the
//                      congrats email to the member via Resend.

import { peekPotwToken, consumePotwToken } from './lib/potw-token.js';
import { loadPending, sendApprovedPotw } from './lib/potw-email.js';
import { resultPage } from './lib/ladder-notify.js';

const ACCENT = '#b8ff2c';
const RED = '#ff5c47';

function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'them'; }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function confirmPage(token, rec) {
  const w = rec?.winner || {};
  const toLine = rec.recipientType === 'captain'
    ? `to captain <b>${esc(rec.captainName || 'captain')}</b> (${esc(rec.to)}) to relay`
    : `to <b>${esc(rec.to)}</b>`;
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Send Player of the Week email</title>
<style>body{font-family:'Inter',system-ui,sans-serif;background:#0e0e0e;color:#f0f0ec;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{max-width:420px;text-align:center}.tag{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:${ACCENT};margin-bottom:10px}
h1{font-size:1.35rem;margin:0 0 10px}p{color:#9a9e97;line-height:1.55;font-size:.95rem;margin:0 0 22px}
button{font-family:inherit;font-size:.95rem;font-weight:800;border:0;cursor:pointer;border-radius:9999px;padding:14px 30px;background:${ACCENT};color:#0e0e0e}
.wm{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5e625c;margin-top:26px}</style></head>
<body><div class="box"><div class="tag">K'CHN Player of the Week &middot; Week ${esc(rec.week)}</div>
<h1>Send ${esc(firstName(w.name))}'s award email?</h1>
<p>This sends the branded congrats email ${toLine}. You'll be BCC'd. This can only be done once.</p>
<form method="POST"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Approve &amp; send now</button></form>
<div class="wm">The Dink Society</div></div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } });
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const token = url.searchParams.get('t');
    const rec = await peekPotwToken(token);
    if (!rec) return resultPage('Link expired', 'This approval link is no longer valid. It may have already been used.', RED);
    const pending = await loadPending(rec.circuit, rec.week, rec.winnerKey);
    if (!pending) return resultPage('Nothing to send', 'We could not find this week’s drafted email. It may have been cleared.', RED);
    if (pending.status === 'sent') return resultPage('Already sent', `${firstName(pending.winner?.name)}’s Player of the Week email already went out.`, ACCENT);
    return confirmPage(token, pending);
  }

  if (req.method === 'POST') {
    let token = url.searchParams.get('t');
    try {
      const body = await req.text();
      const params = new URLSearchParams(body);
      token = params.get('t') || token;
    } catch {}
    const rec = await consumePotwToken(token);
    if (!rec) return resultPage('Link expired', 'This approval link is no longer valid. It may have already been used.', RED);
    try {
      const out = await sendApprovedPotw(rec.circuit, rec.week, rec.winnerKey);
      if (!out.ok && out.reason === 'already-sent') return resultPage('Already sent', `${firstName(out.name)}’s email already went out.`, ACCENT);
      if (!out.ok) return resultPage('Could not send', 'Something went wrong preparing this email. Please send it manually.', RED);
      return resultPage('Sent! \u{1F389}', `${firstName(out.name)}’s Player of the Week email is on its way to ${esc(out.to)}. Nice cooking.`, ACCENT);
    } catch (e) {
      console.error('[potw-approve] send failed:', e);
      return resultPage('Could not send', 'The email failed to send. Please try again or send it manually.', RED);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/potw-approve' };
