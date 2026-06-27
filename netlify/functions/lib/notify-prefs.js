// netlify/functions/lib/notify-prefs.js
// Per-player email notification preferences + the gate/footer used by every
// ladder notification send.
//
//   notify-prefs   pref/<email>.json   { email, all, types:{...}, updatedAt }
//
// Default (no record) = opted in to everything. `all:false` is the master
// unsubscribe. Only the OPTIONAL "going-forward" categories are toggleable.
// Registration confirmations ("you're in" / "pay your spot") are MANDATORY for
// a paid signup — they always send and aren't shown on the manage page.
//
// The manage link is a stateless HMAC token over the email (stable, not
// single-use) so an unsubscribe link keeps working — unlike the one-tap action
// tokens in lib/ladder-token.js.

import crypto from 'crypto';
import { getStore } from '@netlify/blobs';
import { sendEmail } from './email.js';
import { siteUrl } from './ladder-notify.js';
import { normalizeEmail } from './identity.js';

const STORE = 'notify-prefs';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

// The notification categories a player can toggle. Keep keys stable — they're
// persisted and referenced by the manage page.
export const NOTIFY_TYPES = [
  { key: 'new_ladders', label: 'New ladder announcements', desc: 'When a new ladder opens for registration.' },
  { key: 'reminders',   label: 'Roster reminders',         desc: 'Reminders before a night you’re registered for.' },
  { key: 'waitlist',    label: 'Waitlist & spot alerts',   desc: 'When a spot opens for you off the waitlist.' },
  { key: 'recap',       label: 'Post-night recap',         desc: 'Your results and the recap after each night.' },
];
const TYPE_KEYS = NOTIFY_TYPES.map(t => t.key);

function secret() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('NOTIFY_PREFS_SECRET'))
    || process.env.NOTIFY_PREFS_SECRET || 'ds-notify-prefs-fallback-secret-change-me';
}
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function sign(payload) { return crypto.createHmac('sha256', secret()).update(payload).digest('hex'); }

/** Stable manage token carrying the email. token = b64url(email).hmac */
export function manageToken(email) {
  const e = normalizeEmail(email) || '';
  const p = b64url(e);
  return `${p}.${sign(p)}`;
}
/** Verify a manage token → normalized email, or null. */
export function emailFromToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  let expected;
  try { expected = sign(p); } catch { return null; }
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return normalizeEmail(unb64url(p)); } catch { return null; }
}

const key = (email) => `pref/${encodeURIComponent(normalizeEmail(email) || '')}.json`;

/** Read prefs (defaults to all-on). Returns { email, all, types:{key:bool} }. */
export async function getPrefs(email) {
  const e = normalizeEmail(email);
  const rec = e ? await store().get(key(e), { type: 'json' }).catch(() => null) : null;
  const types = {};
  for (const k of TYPE_KEYS) types[k] = rec?.types?.[k] !== false; // default true
  return { email: e, all: rec?.all !== false, types };
}

/** Persist prefs. `all` is the master switch; `types` is a partial map. */
export async function setPrefs(email, { all, types } = {}) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const cur = await getPrefs(e);
  const next = {
    email: e,
    all: all == null ? cur.all : !!all,
    types: { ...cur.types },
    updatedAt: new Date().toISOString(),
  };
  if (types) for (const k of TYPE_KEYS) if (k in types) next.types[k] = !!types[k];
  await store().setJSON(key(e), next);
  return next;
}

/**
 * Would this recipient accept an email of this category? Mandatory/transactional
 * categories (anything not in NOTIFY_TYPES, e.g. 'confirmations') always send and
 * bypass the master unsubscribe. Optional categories respect the master + per-type.
 */
export async function wantsEmail(email, category) {
  if (!category || !TYPE_KEYS.includes(category)) return true;
  const p = await getPrefs(email);
  if (!p.all) return false;
  return p.types[category] !== false;
}

/** Footer with manage + one-click unsubscribe links, appended to every gated email. */
export function prefsFooter(email) {
  const t = manageToken(email);
  const base = siteUrl();
  const manage = `${base}/.netlify/functions/ladder-prefs?t=${encodeURIComponent(t)}`;
  const unsub = `${manage}&all=0&go=1`;
  return `<div style="margin-top:18px;padding-top:14px;border-top:1px solid #1f1f1f;font-size:11px;color:#5e625c;line-height:1.7">
    <a href="${manage}" style="color:#8a8a8a;text-decoration:underline">Manage email preferences</a> &nbsp;·&nbsp; <a href="${unsub}" style="color:#8a8a8a;text-decoration:underline">Unsubscribe from all</a>
  </div>`;
}

/**
 * Gate + footer wrapper around sendEmail for player-facing notifications.
 * Skips the send if the recipient opted out of `category`; otherwise appends the
 * manage/unsubscribe footer. Organizer/operational mail can pass category=null
 * to always send with no footer.
 * Returns { skipped } or whatever sendEmail returns.
 */
export async function sendNotify({ to, category, subject, html, from, replyTo }) {
  if (category && !(await wantsEmail(to, category))) return { skipped: true, to };
  const body = category ? html + prefsFooter(to) : html;
  return sendEmail({ to, from, replyTo, subject, html: body });
}
