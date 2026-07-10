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
import { dateLineOf, organizerEmails, fmtCents, resultPage, siteUrl, fillSpotShare } from './lib/ladder-notify.js';

const RED = '#ff5c47', LIME = '#b8ff2c', TEAL = '#17d7b0';
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

// Success page after a drop that leaves a genuinely open spot: instead of a dead
// end, hand the player a ready-to-share recruit link so they can find their own
// backfill (native share / copy / text / WhatsApp / email, prewritten text).
function filledResultPage(event, share, { credited, promoted } = {}) {
  const creditNote = credited ? ` A ${fmtCents(credited)} ladder credit is on your account for next time.` : '';
  const promoteNote = promoted === 'fcfs'
    ? `We've also let the waitlist know it's first-come — but the more the merrier.`
    : `There's no one waiting, so the fastest way to fill it is to invite someone yourself.`;
  const url = share.url, full = share.full;
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Help fill your spot</title>
<style>body{font-family:'Inter',system-ui,sans-serif;background:#0e0e0e;color:#f0f0ec;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{max-width:440px;width:100%;text-align:center}.ic{width:60px;height:60px;border-radius:50%;background:${LIME}22;display:flex;align-items:center;justify-content:center;font-size:1.9rem;margin:0 auto 14px}
h1{font-size:1.3rem;margin:0 0 8px;color:${LIME}}.sub{color:#9a9e97;line-height:1.55;font-size:.92rem;margin:0 0 22px}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:16px;padding:20px 18px;text-align:left}
.tag{font-size:.65rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:${TEAL};margin:0 0 8px}
.ev{font-size:1rem;font-weight:800;color:#fff;margin:0 0 2px}.when{font-size:.8rem;color:${TEAL};font-weight:700;margin:0 0 14px}
.linkrow{display:flex;gap:8px;margin:0 0 14px}.linkrow input{flex:1;min-width:0;background:#0e0e0e;border:1px solid #2a2a2a;border-radius:9999px;color:#cfcfcf;font-size:.78rem;padding:10px 14px;font-family:inherit}
.copy{border:0;cursor:pointer;border-radius:9999px;padding:10px 16px;background:${LIME};color:#0e0e0e;font-weight:800;font-size:.8rem;font-family:inherit;white-space:nowrap}
.share{display:inline-block;width:100%;box-sizing:border-box;text-align:center;border:0;cursor:pointer;border-radius:9999px;padding:14px;background:${TEAL};color:#04120f;font-weight:800;font-size:.95rem;font-family:inherit;margin:0 0 10px;text-decoration:none}
.chips{display:flex;gap:8px}.chip{flex:1;text-align:center;text-decoration:none;border:1px solid #2a2a2a;border-radius:9999px;padding:11px 0;color:#e6e6e6;font-weight:700;font-size:.82rem}
.wm{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5e625c;margin-top:26px}</style></head>
<body><div class="box"><div class="ic">✓</div><h1>You're off the list</h1>
<p class="sub">Thanks for letting us know.${creditNote} ${promoteNote}</p>
<div class="card"><div class="tag">🪜 Help fill your spot</div>
<div class="ev">${esc(event.name)}</div><div class="when">${esc(dateLineOf(event))}</div>
<button class="share" id="shareBtn" type="button">Share this spot</button>
<div class="linkrow"><input id="lnk" type="text" readonly value="${esc(url)}"><button class="copy" id="copyBtn" type="button">Copy</button></div>
<div class="chips"><a class="chip" href="${esc(share.smsUrl)}">Text</a><a class="chip" href="${esc(share.waUrl)}" target="_blank" rel="noopener">WhatsApp</a><a class="chip" href="${esc(share.mailUrl)}">Email</a></div>
</div><div class="wm">The Dink Society</div></div>
<script>
var SHARE_URL=${JSON.stringify(url)},SHARE_TEXT=${JSON.stringify(full)},SHARE_TITLE=${JSON.stringify('Open spot: ' + event.name)};
var sb=document.getElementById('shareBtn'),cb=document.getElementById('copyBtn'),ln=document.getElementById('lnk');
function flash(el,msg){var o=el.textContent;el.textContent=msg;setTimeout(function(){el.textContent=o;},1600);}
sb.addEventListener('click',function(){if(navigator.share){navigator.share({title:SHARE_TITLE,text:SHARE_TEXT,url:SHARE_URL}).catch(function(){});}else{copy();}});
function copy(){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(SHARE_URL).then(function(){flash(cb,'Copied');},sel);}else{sel();}}
function sel(){ln.focus();ln.select();try{document.execCommand('copy');flash(cb,'Copied');}catch(e){}}
cb.addEventListener('click',copy);
</script>
</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// Alert the organizers that someone dropped (and what happened to the spot).
async function notifyAdminDrop(event, who, creditedCents, opened, signups, wasWaitlist, share) {
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
    ${share ? `<div style="background:#12140f;border:1px solid rgba(184,255,44,.25);border-radius:10px;padding:14px 16px;margin-top:14px;font-size:13px;color:#cfcfcf;line-height:1.7">
      <div style="font-weight:800;color:#b8ff2c;text-transform:uppercase;letter-spacing:.08em;font-size:11px;margin-bottom:6px">Need to fill it?</div>
      Forward this register link to anyone who might want the spot:<br>
      <a href="${esc(share.url)}" style="color:#17d7b0;word-break:break-all">${esc(share.url)}</a><br>
      <span style="color:#777">Or open <b style="color:#8a8a8a">admin-ladders.html</b> → Recruit players to email every past player at once.</span>
    </div>` : ''}
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

    // Is the spot actually open for a backfill? Yes when a roster seat was freed and
    // it wasn't handed to a specific waitlister on a 30-min hold. (null = no waitlist,
    // 'fcfs' = still open to everyone; a name = reserved, so don't push public sharing.)
    const canRecruit = !!removed && (opened.opened == null || opened.opened === 'fcfs');
    const share = canRecruit ? fillSpotShare(event) : null;

    try { await notifyAdminDrop(event, removed || { name: rec.name, email: rec.email }, credited, opened, signups, wasWaitlist, share); } catch {}

    // Spot's open → give the player a share-to-recruit page instead of a dead end.
    if (share) return filledResultPage(event, share, { credited, promoted: opened.opened });

    return resultPage('You\'re off the list',
      `Thanks for letting us know.${credited ? ` A ${fmtCents(credited)} ladder credit is on your account for next time.` : ''}${opened.opened ? ' Your spot has been offered to the waitlist.' : ''}`,
      LIME);
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/ladder-cancel' };
