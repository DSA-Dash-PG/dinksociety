// netlify/functions/potw-size.js
// PUBLIC one-tap shirt-size capture for the K'CHN Player of the Week email.
//
//   GET ?t=<sizeToken>&size=<XS|S|M|L|XL|2XL>
//     → verify the signed token (circuit/week/winnerKey), record the size against
//       that week's pending record, and render a branded confirmation page that
//       lets the player change their pick. Idempotent and safe to re-hit, so an
//       email-client prefetch can't do harm (worst case it records a size the
//       player then corrects with one tap).
//
// No admin/auth: the HMAC-signed token is the authorization, and it only lets the
// holder set THEIR OWN size for THAT week.

import { verifySizeToken } from './lib/potw-size-token.js';
import { recordPotwSize, loadPending } from './lib/potw-email.js';

const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
const ACCENT = '#b8ff2c';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }

function page({ title, heading, body, sizeRow }) {
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
  body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#0e0e0e;color:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
  .box{max-width:440px;text-align:center}
  .tag{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:${ACCENT};margin-bottom:12px}
  h1{font-size:1.5rem;font-weight:800;margin:0 0 10px}
  p{color:#9a9e97;line-height:1.55;font-size:.95rem;margin:0 0 20px}
  .sizes{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:6px 0 4px}
  .sizes a{text-decoration:none;font-weight:800;font-size:.95rem;border-radius:9px;padding:11px 18px;border:1px solid #2a2a2a;background:#161616;color:#f5f5f5}
  .sizes a.on{background:${ACCENT};color:#0e0e0e;border-color:${ACCENT}}
  .wm{font-size:.7rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#5e625c;margin-top:28px}
</style></head>
<body><div class="box">
  <div class="tag">K'CHN Player of the Week</div>
  <h1>${esc(heading)}</h1>
  <p>${body}</p>
  ${sizeRow || ''}
  <div class="wm">The Dink Society &middot; presented by K'CHN</div>
</div></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get('t');
  const decoded = verifySizeToken(token);
  if (!decoded) {
    return page({ title: 'Link expired', heading: 'This link is no longer valid', body: 'Please use the size buttons in your award email, or reply to it and we will sort your size out.' });
  }

  const requested = (url.searchParams.get('size') || '').trim().toUpperCase();
  const size = SIZES.find(s => s === requested) || null;

  let rec = await loadPending(decoded.circuit, decoded.week, decoded.winnerKey);
  if (size) {
    const updated = await recordPotwSize(decoded.circuit, decoded.week, decoded.winnerKey, size);
    if (updated) rec = updated;
  }

  const current = rec?.size?.value || null;
  const name = firstName(rec?.winner?.name);
  const sizeRow = `<div class="sizes">${SIZES.map(s =>
    `<a class="${current === s ? 'on' : ''}" href="?t=${encodeURIComponent(token)}&size=${encodeURIComponent(s)}">${s}</a>`
  ).join('')}</div>`;

  if (size) {
    return page({
      title: 'Size saved',
      heading: `Locked in, ${name}!`,
      body: `Your K'CHN jersey size is <b style="color:#fff">${esc(size)}</b>. We'll have it ready to present courtside on game day. Tap a different size below if you need to change it.`,
      sizeRow,
    });
  }
  return page({
    title: 'Pick your size',
    heading: `Pick your shirt size, ${name}`,
    body: `Your Player of the Week jersey is sponsored by K'CHN. Tap your size and we'll have it ready for you.`,
    sizeRow,
  });
};

export const config = { path: '/.netlify/functions/potw-size' };
