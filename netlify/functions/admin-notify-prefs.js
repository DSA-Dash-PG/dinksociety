// =============================================================
// /api/admin-notify-prefs   (admin session)
//
// Lets an admin see and change a player's email opt-in/opt-out — the
// "please take me off the list" case. Same store the player's own
// manage/unsubscribe links write to (lib/notify-prefs.js), so a player who
// unsubscribed themselves and one an admin flipped look identical to every
// sender.
//
//   GET  ?email=a@b.c                 → { prefs }
//   POST { action:'lookup', emails:[…] }
//                                     → { prefs: { [email]: prefs } }   (bulk, Players tab)
//   POST { action:'set', email, all?, types?, note? }
//                                     → { ok, prefs }
//        all:false  = master unsubscribe (stops every optional category)
//        all:true   = re-subscribe (per-type flags kept as they were)
//        types:{league:false} etc. = flip one category
//   POST { action:'send-link', email, name? }
//                                     → { ok, sent }  emails the player their
//                                       stable manage/unsubscribe link
// =============================================================

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail } from './lib/identity.js';
import { getPrefs, getPrefsMany, setPrefs, prefsLinks, NOTIFY_TYPES } from './lib/notify-prefs.js';
import { sendEmail, renderPrefsLink } from './lib/email.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const TYPE_KEYS = NOTIFY_TYPES.map(t => t.key);

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload || {};

  if (req.method === 'GET') {
    const email = normalizeEmail(new URL(req.url).searchParams.get('email'));
    if (!email) return json({ error: 'email required' }, 400);
    return json({ prefs: await getPrefs(email), types: NOTIFY_TYPES });
  }

  if (req.method !== 'POST') return json({ error: 'GET or POST only' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const action = String(body.action || '');

  // ── Bulk read for the Players table ──
  if (action === 'lookup') {
    const emails = Array.isArray(body.emails) ? body.emails.slice(0, 1000) : [];
    const prefs = await getPrefsMany(emails);
    // Only ship the ones that differ from the default (all-on) — keeps the
    // payload tiny and the client treats "missing" as opted in.
    const out = {};
    for (const [e, p] of Object.entries(prefs)) {
      if (!p.all || TYPE_KEYS.some(k => p.types[k] === false)) out[e] = p;
    }
    return json({ prefs: out, types: NOTIFY_TYPES });
  }

  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'email required' }, 400);

  // ── Flip prefs on the player's behalf ──
  if (action === 'set') {
    const patch = { setBy: admin.email || 'admin' };
    if (body.all != null) patch.all = !!body.all;
    if (body.types && typeof body.types === 'object') {
      patch.types = {};
      for (const k of TYPE_KEYS) if (k in body.types) patch.types[k] = !!body.types[k];
    }
    if (patch.all == null && !patch.types) return json({ error: 'nothing to change' }, 400);
    patch.note = body.note ? String(body.note) : (patch.all === false ? 'opted out by admin' : patch.all === true ? 're-subscribed by admin' : 'category changed by admin');
    const saved = await setPrefs(email, patch);
    return json({ ok: true, prefs: await getPrefs(email), saved });
  }

  // ── Email the player their own manage link ──
  if (action === 'send-link') {
    const { manage, unsub } = prefsLinks(email);
    const html = renderPrefsLink({ playerName: (body.name || '').split(' ')[0], manageUrl: manage, unsubUrl: unsub });
    try {
      await sendEmail({ to: email, subject: 'Your Dink Society email preferences', html });
    } catch (e) {
      return json({ error: 'Send failed: ' + (e && e.message || e) }, 502);
    }
    return json({ ok: true, sent: true, manage });
  }

  return json({ error: `Unknown action: ${action || '(none)'}` }, 400);
};

export const config = { path: '/.netlify/functions/admin-notify-prefs' };
