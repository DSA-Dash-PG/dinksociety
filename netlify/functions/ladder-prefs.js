// netlify/functions/ladder-prefs.js
// No-login email preferences page, reached from the footer of any optional
// ladder notification. The link carries a stable HMAC token over the email
// (lib/notify-prefs.js) — no session needed.
//
//   GET  ?t=<token>              → the preferences form
//   GET  ?t=<token>&all=0&go=1   → one-click "unsubscribe from all optional"
//   POST (form: t + t_<key>…)    → save per-type choices
//
// Registration confirmations are mandatory and never appear here.

import { NOTIFY_TYPES, emailFromToken, getPrefs, setPrefs, manageToken } from './lib/notify-prefs.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const html = (body, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

function page(inner) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email preferences · The Dink Society</title>
<style>
  body{margin:0;background:#0e0e0e;color:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;padding:40px 18px}
  .card{width:100%;max-width:460px}
  .wm{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;margin-bottom:26px}
  .wm .l{color:#17d7b0}
  h1{font-size:24px;font-weight:800;margin:0 0 8px;line-height:1.2}
  .sub{font-size:14px;color:#9a9e97;line-height:1.6;margin:0 0 24px}
  .sub b{color:#cfcfcf;font-weight:700}
  .row{display:flex;gap:13px;align-items:flex-start;background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:15px 16px;margin-bottom:10px;cursor:pointer}
  .row input{margin:2px 0 0;width:20px;height:20px;accent-color:#b8ff2c;flex:none}
  .row .t{font-size:15px;font-weight:700}
  .row .d{font-size:12.5px;color:#8a8a8a;margin-top:3px;line-height:1.5}
  .note{font-size:12px;color:#5e625c;line-height:1.6;margin:14px 2px 22px}
  .btn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:14px;background:#b8ff2c;color:#0e0e0e;font-size:14px;font-weight:800;border:none;border-radius:9999px;cursor:pointer;text-decoration:none}
  .ghost{display:block;text-align:center;margin-top:14px;font-size:13px;color:#8a8a8a;text-decoration:underline}
  .ok{width:60px;height:60px;border-radius:50%;background:rgba(184,255,44,.12);display:flex;align-items:center;justify-content:center;font-size:1.7rem;color:#b8ff2c;margin:0 auto 16px}
  .center{text-align:center}
  .foot{margin-top:30px;padding-top:16px;border-top:1px solid #222;font-size:11px;color:#555}
</style></head><body><div class="card">
  <div class="wm">THE DINK SOCIETY <span class="l">· LADDER</span></div>
  ${inner}
  <div class="foot">Registration confirmations for ladders you sign up for are always sent.</div>
</div></body></html>`;
}

function formPage(email, prefs, saved) {
  const rows = NOTIFY_TYPES.map(t => `
    <label class="row">
      <input type="checkbox" name="t_${t.key}" ${prefs.types[t.key] ? 'checked' : ''}>
      <span><span class="t">${esc(t.label)}</span><span class="d">${esc(t.desc)}</span></span>
    </label>`).join('');
  const tok = manageToken(email);
  return page(`
    ${saved ? '<div style="background:rgba(184,255,44,.12);border:1px solid rgba(184,255,44,.3);color:#b8ff2c;font-size:13px;font-weight:700;border-radius:10px;padding:11px 14px;margin-bottom:18px">✓ Saved. Your preferences are updated.</div>' : ''}
    <h1>Email preferences</h1>
    <p class="sub">Choose what we send to <b>${esc(email)}</b>. Untick anything you’d rather not get — you’ll still get confirmations for ladders you sign up for.</p>
    <form method="POST" action="/.netlify/functions/ladder-prefs">
      <input type="hidden" name="t" value="${esc(tok)}">
      ${rows}
      <div class="note">Tip: unticking everything here is the same as unsubscribing from all optional emails.</div>
      <button class="btn" type="submit">Save preferences</button>
    </form>
    <a class="ghost" href="/.netlify/functions/ladder-prefs?t=${encodeURIComponent(tok)}&all=0&go=1">Unsubscribe from all optional emails</a>
  `);
}

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === 'POST') {
    const form = new URLSearchParams(await req.text());
    const email = emailFromToken(form.get('t'));
    if (!email) return html(page('<h1>Link expired</h1><p class="sub">This preferences link isn’t valid. Open the link from a recent email again.</p>'), 400);
    const types = {};
    for (const t of NOTIFY_TYPES) types[t.key] = form.get(`t_${t.key}`) != null;
    await setPrefs(email, { all: true, types });
    const prefs = await getPrefs(email);
    return html(formPage(email, prefs, true));
  }

  const email = emailFromToken(url.searchParams.get('t'));
  if (!email) return html(page('<h1>Link expired</h1><p class="sub">This preferences link isn’t valid. Open the link from a recent email again.</p>'), 400);

  // One-click unsubscribe from all optional emails.
  if (url.searchParams.get('all') === '0' && url.searchParams.get('go') === '1') {
    await setPrefs(email, { all: false });
    const tok = manageToken(email);
    return html(page(`
      <div class="center">
        <div class="ok">✓</div>
        <h1>You’re unsubscribed</h1>
        <p class="sub">We won’t send optional ladder emails to <b>${esc(email)}</b> anymore. You’ll still get confirmations for any ladder you sign up for.</p>
        <a class="btn" href="/.netlify/functions/ladder-prefs?t=${encodeURIComponent(tok)}">Manage individual preferences</a>
      </div>`));
  }

  const prefs = await getPrefs(email);
  return html(formPage(email, prefs, false));
};

export const config = { path: '/.netlify/functions/ladder-prefs' };
