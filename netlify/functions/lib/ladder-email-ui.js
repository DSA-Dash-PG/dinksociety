// netlify/functions/lib/ladder-email-ui.js
// Shared, email-safe UI pieces for ladder marketing emails (announce + blast):
//   • divisionBadge()  — a big, pronounced MIXED / MEN'S / WOMEN'S pill
//   • spotsModule()    — the live PNG count image + baked Courts/Spots/Field
//                        tiles (the tiles render everywhere and are correct at
//                        send; the image refreshes live where clients allow it)
//   • inviteButton()   — a "＋ Invite a Friend" mailto button, prefilled
//   • ctaButton()      — the primary gradient CTA
//
// Kept framework-free and inline-styled; tables are used where Outlook needs
// them (tiles). Brand: bg #0e0e0e, teal #17d7b0, lime #b8ff2c.

import { dateLineOf, siteUrl } from './ladder-notify.js';
import { effectiveCapacity } from './ladder.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Human division label, e.g. "MIXED LADDER". */
export function divisionLabel(type) {
  const t = String(type || 'mixed').toLowerCase();
  if (t === 'mens' || t === "men's" || t === 'men') return "MEN'S LADDER";
  if (t === 'womens' || t === "women's" || t === 'women') return "WOMEN'S LADDER";
  if (t === 'mixed') return 'MIXED LADDER';
  return `${t.toUpperCase()} LADDER`;
}

/** Title-case division for headline use, e.g. "Mixed", "Women's". */
export function divisionTitle(type) {
  const t = String(type || 'mixed').toLowerCase();
  if (t === 'mens' || t === "men's" || t === 'men') return "Men's";
  if (t === 'womens' || t === "women's" || t === 'women') return "Women's";
  return 'Mixed';
}

/** Courts label: prefer explicit court numbers, else "N courts". */
export function courtsLabel(event) {
  if (event?.courtNumbers) return String(event.courtNumbers);
  const n = Number(event?.courts) || 0;
  return `${n} court${n === 1 ? '' : 's'}`;
}

/** Big, pronounced division pill (lime gradient — degrades to solid lime). */
export function divisionBadge(type) {
  return `<span style="display:inline-block;font-size:14px;font-weight:800;letter-spacing:.04em;color:#0e0e0e;background-color:#b8ff2c;background-image:linear-gradient(135deg,#c6f24e 0%,#8fe04a 100%);padding:8px 18px;border-radius:9999px;margin:0 0 16px">🎾 ${esc(divisionLabel(type))} · OPEN PLAY</span>`;
}

/** Primary gradient CTA button (solid-lime fallback in Outlook). */
export function ctaButton(url, label) {
  return `<a href="${esc(url)}" style="display:inline-block;padding:15px 34px;background-color:#b8ff2c;background-image:linear-gradient(135deg,#c6f24e 0%,#8fe04a 100%);color:#0e0e0e;font-size:15px;font-weight:800;text-decoration:none;border-radius:14px;margin:2px 0">${esc(label)}</a>`;
}

/** Outlined "Invite a Friend" button → opens the reader's mail app, prefilled. */
export function inviteButton(event, site = siteUrl()) {
  const regUrl = `${site}/ladders.html?event=${encodeURIComponent(event.id)}&via=invite`;
  const subject = `Come play ${event.name} with me`;
  const line = dateLineOf(event);
  const body =
    `I'm playing a Dink Society ladder — want in?\n\n` +
    `${event.name}\n${line}\n\n` +
    `Grab a spot here: ${regUrl}`;
  const href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `<a href="${href}" style="display:inline-block;padding:14px 30px;background:transparent;color:#e7eaee;border:1.5px solid #33373c;font-size:14px;font-weight:800;text-decoration:none;border-radius:14px;margin:10px 0 2px">＋ Invite a Friend <span style="color:#17d7b0">— fill the field faster</span></a>`;
}

/** One baked stat tile (renders in every client). */
function tile(num, label, color) {
  return `<td width="33.33%" style="padding:0 5px" valign="top">
    <div style="background:#161616;border:1px solid #23262a;border-radius:14px;padding:16px 6px;text-align:center">
      <div style="font-size:26px;font-weight:800;color:${color};line-height:1">${esc(num)}</div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.08em;color:#8a8f98;text-transform:uppercase;margin-top:6px">${esc(label)}</div>
    </div></td>`;
}

/**
 * The spots module: a live PNG count image on top (updates where the client
 * re-fetches), then baked Courts / Spots Left / Field tiles (always render, and
 * hold the correct number as of send). `left`/`cap` are the send-time values.
 */
export function spotsModule({ event, left, cap, site = siteUrl() }) {
  const capacity = cap != null ? cap : effectiveCapacity(event);
  const badgeUrl = `${site}/.netlify/functions/public-ladder-badge?event=${encodeURIComponent(event.id)}`;
  const courts = Number(event?.courts) || 0;
  return `
    <a href="${site}/ladders.html?event=${encodeURIComponent(event.id)}" style="text-decoration:none;display:block">
      <img src="${esc(badgeUrl)}" width="320" alt="${esc(left)} of ${esc(capacity)} spots left" style="display:block;border:0;outline:none;width:100%;max-width:320px;height:auto;margin:0 0 6px">
    </a>
    <div style="font-size:12px;color:#8a8f98;margin:0 0 16px">🟢 <span style="color:#17d7b0;font-weight:700">Live count</span> — updates as players register.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px"><tr>
      ${tile(courts || '—', 'Courts', '#17d7b0')}
      ${tile(left, 'Spots Left', '#b8ff2c')}
      ${tile(capacity, 'Field', '#17d7b0')}
    </tr></table>`;
}
