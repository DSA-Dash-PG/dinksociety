// netlify/functions/ladder-cancel.js
// One-tap cancel from a reminder email — no login needed (carries its own token).
//
//   GET  ?t=<token>  → peek (does NOT consume) and show a confirm page with a real
//                      "Yes, cancel my spot" button, so an email-client prefetch
//                      can't drop someone by accident.
//   POST (form t=<token>) → consume the token, remove the player, issue a ladder
//                      credit for what they paid, promote the waitlist (which emails
//                      the next player / blasts the FCFS list), and alert organizers.

import { peekLadderToken, consumeLadderToken } from './lib/ladder-token.js';
import { getEvent, getSignups, setSignups, removeFromRoster, effectiveCapacity } from './lib/ladder.js';
import { normalizeEmail } from './lib/identity.js';
import { earn } from './lib/credits.js';
import { promoteAndNotify } from './lib/ladder-promote.js';
import { sendEmail } from './lib/email.js';
import { dateLineOf, organizerEmails, fmtCents, resultPage, siteUrl } from './lib/ladder-notify.js';

const RED = '#ff5c47', LIME = '#b8ff2c';
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || 'there'; }
function onList(signups, rec) {
  const norm = normalizeEmail(rec.email);
  const hit = p => (rec.playerId && p.playerId === rec.playerId) || (norm && normalizeEmail(p.email) === norm);
  if ((signups.roster || []).some(hit)) return 'roster';
  if ((signups.waitlist || []).some(hit)) return 'waitlist';
  return null;
}

function confirmPage(token, rec, event) {
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cancel your ladder spot</title>
<style>body{font-family:'Inter',system-ui,sans-serif;background:#0e0e0e;color:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{max-width:430px;text-align:center}.tag{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#17d7b0;margin-bottom:10px}
h1{font-size:1.4rem;font-weight:800;margin:0 0 10px}p{color:#9a9e97;line-height:1.55;font-size:.95rem;margin:0 0 22px}
button{font-family:inherit;font-size:.95rem;font-weight:800;border:0;cursor:pointer;border-radius:9999px;padding:14px 30px;background:${RED};color:#fff}
a{color:#8a8a8a;font-size:.8rem;display:inline-block;margin-top:18px;text-decoration:none}.wm{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5e625c;margin-top:26px}</style></head>
<body><div class="box"><div class="tag">🪜 The Dink Society Ladder</div>
<h1>Cancel your spot, ${esc(firstName(rec.name || rec.email))}?</h1>
<p>This drops you from <b style="color:#fff">${esc(event.name)}</b> (${esc(dateLineOf(event))}). You'll get a ladder credit for what you paid, and the next person on the waitlist takes your place.</p>
<form method="POST"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Yes, cancel my spot</button></form>
<a href="${siteUrl()}/ladders.html?event=${encodeURIComponent(event.id)}">Never mind, keep my spot</a>
<div class="wm">The Dink Society</div></div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Alert the organizers that someone dropped (and what happened to the spot).
async function notifyAdminDrop(event, who, creditedCents, opened, signups, wasWaitlist) {
  const to = organizerEmails(event);
  if (!to.length) return;
  const cap = effectiveCapacity(event);
  const rosterN = (signups.roster || []).length;
  const spotLine = wasWaitlist ? 'They were on the waitlist (no roster spot freed).'
    : opened && opened.opened === 'fcfs' ? 'Inside 24h — the whole waitlist was emailed first-come-first-served.'
    : opened && opened.opened ? `Promoted next in line: <b style="color:#fff">${esc(opened.opened)}</b> (emailed).`
    : 'No one on the waitlist — the spot is now open.';
  const html = `<div style="background:#0e0e0e;font-family:'Inter',-apple-system,sans-serif;color:#f5f5f5;max-width:520px;margin:0 auto;padding:32px 24px">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#f5f5f5;margin-bottom:8px">THE DINK SOCIETY · LADDER</div>
    <h1 style="font-size:20px;font-weight:800;margin:0 0 6px">A player dropped from ${esc(event.name)}</h1>
    <p style="font-size:14px;color:#9a9e97;line-height:1.6;margin:0 0 16px"><b style="color:#fff">${esc(who.name || who.email)}</b> cancelled (${esc(dateLineOf(event))}).</p>
    <div style="background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:14px 16px;font-size:13.5px;color:#cfcfcf;line-height:1.7">
      ${spotLine}<br>
      Credit issued: <b style="color:#fff">${creditedCents ? fmtCents(creditedCents) : 'none'}</b><br>
      Roster now: <b style="color:#fff">${rosterN} / ${cap}</b> · waitlist: <b style="color:#fff">${(signups.waitlist || []).length}</b>
    </div>
    <div style="margin-top:18px;font-size:11px;color:#555">Manage: ${siteUrl()}/admin-ladders.html</div>
  </div>`;
  await sendEmail({ to, subject: `🪜 ${who.name || who.email} dropped from ${event.name}`, html }).catch(() => {});
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const rec = await peekLadderToken(url.searchParams.get('t'));
    if (!rec || rec.type !== 'cancel') return resultPage('Link expired', 'This cancel link is no longer valid. It may have already been used.', RED);
    const event = await getEvent(rec.eventId);
    if (!event) return resultPage('Not found', 'We could not find that ladder.', RED);
    const signups = await getSignups(rec.eventId);
    if (!onList(signups, rec)) return resultPage('Already off the list', `You're not registered for ${event.name} anymore.`, LIME);
    return confirmPage(url.searchParams.get('t'), rec, event);
  }

  if (req.method === 'POST') {
    let token = url.searchParams.get('t');
    try { const body = await req.text(); token = new URLSearchParams(body).get('t') || token; } catch {}
    const rec = await consumeLadderToken(token);
    if (!rec || rec.type !== 'cancel') return resultPage('Link expired', 'This cancel link is no longer valid or was already used.', RED);
    const event = await getEvent(rec.eventId);
    if (!event) return resultPage('Not found', 'We could not find that ladder.', RED);

    const signups = await getSignups(rec.eventId);
    const removed = removeFromRoster(signups, { playerId: rec.playerId, email: rec.email });
    let wasWaitlist = false;
    if (!removed) {
      const norm = normalizeEmail(rec.email);
      const i = (signups.waitlist || []).findIndex(p => p.playerId === rec.playerId || normalizeEmail(p.email) === norm);
      if (i >= 0) { signups.waitlist.splice(i, 1); wasWaitlist = true; }
      else return resultPage('Already off the list', `You're not registered for ${event.name} anymore.`, LIME);
    }

    // Credit = what they actually paid for THIS ladder (varies by ladder).
    let credited = 0;
    const policy = event.cancelPolicy || 'auto_credit';
    if (removed && policy === 'auto_credit' && removed.paymentStatus === 'paid') {
      const cents = Number(removed.amountCents != null ? removed.amountCents : event.feeCents) || 0;
      if (cents > 0) {
        await earn(rec.email, cents, `Cancelled ${event.name}`, { eventId: event.id, key: `cancel:${event.id}:${normalizeEmail(rec.email)}` }).catch(() => {});
        credited = cents;
      }
    }

    // Free the spot → promote the waitlist (emails them) — only if a roster spot opened.
    let opened = { opened: null };
    if (removed) opened = await promoteAndNotify(event, signups);
    await setSignups(signups);

    try { await notifyAdminDrop(event, removed || { name: rec.name, email: rec.email }, credited, opened, signups, wasWaitlist); } catch {}

    return resultPage('You\'re off the list',
      `Thanks for letting us know.${credited ? ` A ${fmtCents(credited)} ladder credit is on your account for next time.` : ''}${opened.opened ? ' Your spot has been offered to the waitlist.' : ''}`,
      LIME);
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/ladder-cancel' };
