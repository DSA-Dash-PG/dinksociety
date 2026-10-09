// netlify/functions/desk-approve.js
//
// The other end of the Desk inbox: the "Approve" button in the review email.
// The token in the link is the auth (unguessable, single-use, expiring) — no
// sign-in, same trust model as the roster / profile / POTW approval links.
//
//   GET  ?t=<approve token>            → a page that says what is about to go
//                                         out and submits itself (one tap from
//                                         the email is the approval)
//   POST t=<approve token>             → consume the token and do it:
//                                         drop          publish + portal post + player email
//                                         ladder-recap  save the write-up + email the roster
//   GET  ?t=<view token>&view=json     → the Drop draft, for /drop.html?preview=1&t=…
//                                         (read-only, never consumed)
//
// Why GET does not publish by itself: mail scanners and link previews fetch
// URLs. A fetch gets the page; only a real browser that has painted it submits
// the form. Set DESK_APPROVE_CONFIRM=1 to turn the auto-submit off and require
// a second tap on the page's button instead.

import { getDrop, publishDrop, markBroadcast } from './lib/drop.js';
import { livePerformers } from './lib/drop-insights.js';
import { seasonName } from './lib/circuit.js';
import { getRecap, updateRecapDraft } from './lib/ladder-recap.js';
import { sendRecapToAll } from './lib/ladder-recap-send.js';
import { siteUrl } from './lib/ladder-notify.js';
import { broadcastDrop } from './admin-drop.js';
import { readDeskToken, consumeDeskToken, releaseDeskToken, getItem, saveItem, esc } from './lib/desk-inbox.js';

const LIME = '#b8ff2c', GOLD = '#f5c842', RED = '#ff5c47';

function env(name) {
  return (typeof Netlify !== 'undefined' && Netlify.env.get(name)) || process.env[name] || '';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function page(title, bodyHtml, accent = LIME, status = 200) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;background:#0e0e0e;color:#f0f0ec;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{max-width:440px;width:100%;text-align:center}.tag{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:${accent};margin-bottom:12px}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 10px}p{color:#9a9e97;line-height:1.55;font-size:.95rem;margin:0 0 18px}p b{color:#f0f0ec}
a{color:${LIME}}button,.btn{font-family:inherit;font-size:1rem;font-weight:800;border:0;cursor:pointer;border-radius:9999px;padding:15px 32px;background:${LIME};color:#0e0e0e;text-decoration:none;display:inline-block}
button[disabled]{opacity:.6;cursor:default}.sub{font-size:.8rem;color:#6d716a;margin-top:16px}
.wm{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5e625c;margin-top:28px}</style></head>
<body><div class="box">${bodyHtml}<div class="wm">The Dink Society</div></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
}

const note = (tag, title, msg, accent, status) =>
  page(title, `<div class="tag">${esc(tag)}</div><h1 style="color:${accent}">${title}</h1><p>${msg}</p>`, accent, status);

const adminLink = () => `<a href="${siteUrl()}/admin.html">Open admin</a>`;
const dropLink = (circuit, edition) => `${siteUrl()}/drop.html?edition=${encodeURIComponent(edition)}&circuit=${encodeURIComponent(circuit)}`;

// The self-submitting approve page. `what` is one sentence on the consequence.
function approvePage(token, { tag, title, what, button }) {
  const manual = String(env('DESK_APPROVE_CONFIRM') || '') === '1';
  const auto = manual ? '' : `<script>(function(){
  var f=document.getElementById('f'),b=document.getElementById('b'),s=document.getElementById('s'),done=false;
  function go(){ if(done) return; done=true; b.disabled=true; b.textContent='Working…'; s.textContent='One moment. Do not close this page.'; f.submit(); }
  f.addEventListener('submit',function(){ done=true; b.disabled=true; b.textContent='Working…'; });
  if(navigator.webdriver) return;
  function arm(){ if(document.visibilityState!=='visible'||done) return; requestAnimationFrame(function(){ requestAnimationFrame(function(){ setTimeout(go,300); }); }); }
  if(document.visibilityState==='visible') arm(); else document.addEventListener('visibilitychange',arm);
})();</script>`;
  return page(title, `<div class="tag">${esc(tag)}</div><h1>${esc(title)}</h1><p>${what}</p>
<form id="f" method="POST" action="/.netlify/functions/desk-approve"><input type="hidden" name="t" value="${esc(token)}"><button id="b" type="submit">${esc(button)}</button></form>
<div class="sub" id="s">Tap the button if this page does not move on by itself.</div>${auto}`);
}

async function showApprove(token, tok) {
  const item = tok.item;

  if (item.kind === 'drop') {
    const rec = await getDrop(item.circuit, item.edition);
    if (!rec) return note('The Drop', 'Nothing to publish', `That draft no longer exists. ${adminLink()} to check.`, RED);
    if (rec.status === 'published') {
      return note(rec.kicker || 'The Drop', 'Already live', `<b>${esc(rec.title)}</b> is published. <a href="${dropLink(item.circuit, rec.edition)}">Read it on the site</a>.`, LIME);
    }
    if (!tok.usable) return note('The Drop', 'Link expired', `This approve link was already used or has expired. ${adminLink()} to publish from the composer.`, RED);
    return approvePage(token, {
      tag: `${rec.kicker || 'The Drop · ' + rec.label} · ${seasonName(rec.circuit)}`,
      title: rec.title,
      what: 'Publishing puts it live on the site, posts it to every team portal and emails the players.',
      button: 'Approve & publish',
    });
  }

  if (item.kind === 'ladder-recap') {
    const inbox = await getItem(item);
    const recap = await getRecap(item.eventId);
    if (!inbox || !recap) return note('Ladder recap', 'Nothing to send', `That write-up no longer exists. ${adminLink()} to check.`, RED);
    if (inbox.status === 'approved') return note('Ladder recap', 'Already sent', `<b>${esc(inbox.title)}</b> was approved and sent to the players.`, LIME);
    if (!tok.usable) return note('Ladder recap', 'Link expired', `This approve link was already used or has expired. ${adminLink()} to send it from the Recap panel.`, RED);
    const n = (recap.recipients || []).length;
    return approvePage(token, {
      tag: `Ladder recap · ${recap.event?.name || 'Ladder night'}`,
      title: inbox.title,
      what: recap.status === 'sent'
        ? `The automatic recap already went out for this night. This saves the write-up and emails the recap to ${n} player${n === 1 ? '' : 's'} again with it.`
        : `This saves the write-up and emails the recap to ${n} player${n === 1 ? '' : 's'}.`,
      button: `Approve & send to ${n}`,
    });
  }

  return note('The Desk', 'Link expired', `This approve link is not valid. ${adminLink()}.`, RED);
}

async function approveDrop(item) {
  const existing = await getDrop(item.circuit, item.edition);
  if (!existing) return note('The Drop', 'Nothing to publish', `That draft no longer exists. ${adminLink()} to check.`, RED);
  const link = dropLink(item.circuit, existing.edition);
  if (existing.status === 'published') {
    return note(existing.kicker || 'The Drop', 'Already live', `<b>${esc(existing.title)}</b> is published. <a href="${link}">Read it on the site</a>.`, LIME);
  }

  // Same steps as the composer's "Approve & Publish" (admin-drop.js action=publish),
  // with both channels on.
  const performers = await livePerformers(item.circuit);
  let rec = await publishDrop(item.circuit, item.edition, null, performers);

  let line = '';
  try {
    const kick = Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join('');
    const b = await broadcastDrop(rec, null, { sendEmail: true, audience: 'players', kickToken: kick });
    rec = (await markBroadcast(item.circuit, item.edition, b.broadcastId)) || rec;
    line = `Posted to ${b.teamCount} team portal${b.teamCount === 1 ? '' : 's'}`
      + (b.recipients
        ? (b.queued ? ` and emailing ${b.recipients} players now.` : `. The player email did not start (${b.recipients} recipients): open admin and use Re-publish to send it.`)
        : '. No player emails were found for this season.')
      + (b.noEmail ? ` ${b.noEmail} player${b.noEmail === 1 ? ' has' : 's have'} no email on file.` : '');
  } catch (e) {
    console.error('[desk-approve] published, but the broadcast failed:', e);
    line = 'It is live, but notifying the players failed. Open admin and use Re-publish to send it.';
  }

  const inbox = await getItem(item);
  if (inbox) await saveItem({ ...inbox, status: 'approved', approvedAt: new Date().toISOString(), approvedVia: 'email-link' }).catch(() => {});

  return page('Live', `<div class="tag">${esc(rec.kicker || 'The Drop')}</div><h1 style="color:${LIME}">It&rsquo;s live &#10003;</h1>
<p><b>${esc(rec.title)}</b></p><p>${esc(line)}</p><a class="btn" href="${link}">Read it on the site</a>`);
}

async function approveLadder(item) {
  const inbox = await getItem(item);
  if (!inbox || !inbox.payload) return note('Ladder recap', 'Nothing to send', `That write-up no longer exists. ${adminLink()} to check.`, RED);
  if (inbox.status === 'approved') return note('Ladder recap', 'Already sent', `<b>${esc(inbox.title)}</b> was already approved and sent.`, LIME);

  // Exactly the manual steps: Recap → Edit write-up → Save, then Send to N players.
  const p = inbox.payload;
  const saved = await updateRecapDraft(item.eventId, { recap: { title: p.title, dek: p.dek, html: p.html, seasonNote: p.seasonNote } });
  if (!saved) return note('Ladder recap', 'Nothing to send', `There is no recap for that night to attach the write-up to. ${adminLink()}.`, RED);

  const sent = await sendRecapToAll(item.eventId, { url: siteUrl() });
  await saveItem({ ...inbox, status: 'approved', approvedAt: new Date().toISOString(), approvedVia: 'email-link', sent: sent.ok ? sent.sent : 0 }).catch(() => {});
  if (!sent.ok) {
    return note('Ladder recap', 'Saved, not sent', `The write-up is saved on the recap, but the email did not go out: ${esc(sent.error || 'unknown error')}. Send it from the Recap panel in admin.`, GOLD);
  }
  const missed = sent.optedOut.length + sent.errored.length + sent.unmatched.length;
  return page('Sent', `<div class="tag">Ladder recap &middot; ${esc(saved.event?.name || '')}</div><h1 style="color:${LIME}">Sent &#10003;</h1>
<p><b>${esc(p.title)}</b></p><p>Emailed to ${sent.sent} player${sent.sent === 1 ? '' : 's'}${missed ? `; ${missed} did not get it (opted out, no stats matched, or a send error). The Recap panel in admin lists who.` : '.'}</p>`);
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const token = url.searchParams.get('t');
    const tok = await readDeskToken(token);

    // Draft preview for the article page. Either token for that edition will do.
    if (url.searchParams.get('view') === 'json') {
      if (!tok || tok.expired || tok.item.kind !== 'drop') return json({ error: 'Preview link expired' }, 401);
      const rec = await getDrop(tok.item.circuit, tok.item.edition);
      if (!rec) return json({ record: null });
      return json({ record: rec, livePerformers: await livePerformers(tok.item.circuit), preview: rec.status !== 'published' });
    }

    if (!tok || tok.action !== 'approve') return note('The Desk', 'Link expired', `This approve link is not valid. ${adminLink()}.`, RED);
    try {
      return await showApprove(token, tok);
    } catch (e) {
      console.error('[desk-approve] page failed:', e);
      return note('The Desk', 'Something went wrong', `Could not load that item. ${adminLink()}.`, RED, 500);
    }
  }

  if (req.method === 'POST') {
    let token = url.searchParams.get('t');
    try { token = new URLSearchParams(await req.text()).get('t') || token; } catch {}

    const tok = await consumeDeskToken(token);
    if (!tok) {
      // Used, expired or unknown. If it was simply used already (a double tap,
      // a refresh), say what state the thing is in rather than "expired".
      const seen = await readDeskToken(token);
      if (seen && seen.action === 'approve') { try { return await showApprove(token, seen); } catch {} }
      return note('The Desk', 'Link expired', `This approve link was already used or has expired. ${adminLink()}.`, RED);
    }

    try {
      if (tok.item.kind === 'drop') return await approveDrop(tok.item);
      if (tok.item.kind === 'ladder-recap') return await approveLadder(tok.item);
      return note('The Desk', 'Link expired', `This approve link is not valid. ${adminLink()}.`, RED);
    } catch (e) {
      console.error('[desk-approve] failed:', e);
      // A Drop that never reached "published" changed nothing a reader can see:
      // give the link back so the same email can be tapped again. (A ladder
      // send may have gone out to some players already — never retry that.)
      if (tok.item.kind === 'drop') {
        const now = await getDrop(tok.item.circuit, tok.item.edition).catch(() => null);
        if (now && now.status !== 'published' && await releaseDeskToken(token)) {
          return note('The Drop', 'That did not go through', `Nothing was published (${esc(String(e && e.message || e))}). Tap the Approve button in the email again, or ${adminLink()} to publish from the composer.`, GOLD, 500);
        }
      }
      return note('The Desk', 'Something went wrong', `It could not be completed: ${esc(String(e && e.message || e))}. ${adminLink()} to finish it there.`, RED, 500);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/desk-approve' };
