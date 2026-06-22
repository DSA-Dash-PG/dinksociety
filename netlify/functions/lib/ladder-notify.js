// netlify/functions/lib/ladder-notify.js
// Small shared helpers for ladder emails/links — URLs, the human date line, and
// who counts as an organizer (recipients of the Venmo one-tap confirm).

export function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

const fn = (name, token) => `${siteUrl()}/.netlify/functions/${name}?t=${token}`;
export const claimUrl = (token) => fn('ladder-claim', token);
export const venmoConfirmUrl = (token) => fn('ladder-confirm-venmo', token);
export const venmoDeclineUrl = (token) => fn('ladder-confirm-venmo', token);

/** "Sat, Jun 20 · 8:30 AM · SBTC" from an event record. */
export function dateLineOf(ev) {
  const parts = [];
  if (ev?.date) {
    const d = new Date(`${ev.date}T12:00:00`);
    if (!isNaN(d)) parts.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
  }
  if (ev?.startTime) parts.push(ev.startTime);
  if (ev?.place) parts.push(ev.place);
  return parts.join(' · ');
}

/**
 * Organizer recipients for the Venmo confirm email: the event's own organizers,
 * plus an env fallback (comma-separated), deduped + lowercased.
 */
export function organizerEmails(ev) {
  const set = new Set();
  const add = (e) => { const x = (e || '').trim().toLowerCase(); if (x.includes('@')) set.add(x); };
  for (const e of (ev?.organizers || [])) add(e);
  const env = (typeof Netlify !== 'undefined' && Netlify.env.get('LADDER_ORGANIZER_EMAILS')) || process.env.LADDER_ORGANIZER_EMAILS || '';
  for (const e of env.split(',')) add(e);

  // Fallback so a Venmo-confirm email is NEVER sent to nobody: if no organizer
  // was configured on the ladder, route it to whoever created the ladder, then
  // to a league-wide admin address. Without this, a ladder created with the
  // organizer field left blank would silently drop the confirm email.
  if (set.size === 0) {
    add(ev?.createdBy);
    const admin = (typeof Netlify !== 'undefined' && (Netlify.env.get('EMAIL_ADMIN_BCC') || Netlify.env.get('EMAIL_REPLY_TO'))) || process.env.EMAIL_ADMIN_BCC || process.env.EMAIL_REPLY_TO || '';
    for (const e of admin.split(',')) add(e);
  }
  return [...set];
}

/** Format integer cents as "$7" or "$7.50". */
export function fmtCents(cents) {
  const n = (Number(cents) || 0) / 100;
  return '$' + (Number.isInteger(n) ? n : n.toFixed(2));
}

/** Tiny standalone HTML page returned by the one-tap link endpoints. */
export function resultPage(title, message, accent = '#b8ff2c') {
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:'Inter',system-ui,sans-serif;background:#0e0e0e;color:#f0f0ec;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.box{max-width:380px;text-align:center}.ic{width:64px;height:64px;border-radius:50%;background:rgba(184,255,44,.12);display:flex;align-items:center;justify-content:center;font-size:2rem;margin:0 auto 16px}
h1{font-size:1.3rem;margin:0 0 8px}p{color:#9a9e97;line-height:1.5;font-size:.92rem}.wm{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5e625c;margin-top:28px}</style></head>
<body><div class="box"><div class="ic" style="background:${accent}22">✓</div><h1 style="color:${accent}">${title}</h1><p>${message}</p><div class="wm">The Dink Society</div></div></body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } });
}
