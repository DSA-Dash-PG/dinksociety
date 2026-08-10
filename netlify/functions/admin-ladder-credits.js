// netlify/functions/admin-ladder-credits.js
// Admin credit lookup + manual grant/adjust/void for LADDER credit. Admin session only.
// Credits live in the ladder-credits store keyed by normalized email (lib/credits.js);
// there was no way to view a player's balance from admin before this.
//
//   GET  (no params)                                   → { active:[{email,name,balanceCents,updatedAt}], count, totalCents }
//   GET  ?email=<email>                                → { email, balanceCents, ledger }
//   GET  ?q=<name-or-email>                            → { query, matches:[{name,email,balanceCents}] }
//   POST { action:'grant',  email, cents, reason }     → issue credit (earn)
//   POST { action:'adjust', email, cents, reason }     → +/- correction (adjust)
//   POST { action:'void',   email, entryId, reason }   → reverse ONE ledger entry
//   POST { action:'void',   email, all:true, reason }  → zero out the whole balance

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail } from './lib/identity.js';
import { getCredit, earn, adjust, voidEntry, voidAll, listAll } from './lib/credits.js';
import { getDirectory } from './lib/player-directory.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

// Annotate a credit record's ledger so the UI knows which lines can be voided:
// `isVoid` marks a reversing entry; `voided` marks an entry that has been reversed.
function annotate(rec) {
  const voided = new Set();
  for (const e of rec.ledger || []) {
    if (typeof e.key === 'string' && e.key.startsWith('void:')) voided.add(e.key.slice(5));
  }
  const ledger = (rec.ledger || []).map((e) => ({
    ...e,
    isVoid: typeof e.key === 'string' && e.key.startsWith('void:'),
    voided: voided.has(e.id),
  }));
  return { ...rec, ledger };
}

// Build a de-duplicated { normalizedEmail -> displayName } index from every place
// a player's email lives: the ladder directory, lite ladder accounts, and team
// rosters. Keeps the longest non-empty name seen for each email.
async function buildPeopleIndex() {
  const byEmail = new Map();
  const remember = (email, name) => {
    const norm = normalizeEmail(email);
    if (!norm) return;
    const nm = String(name || '').trim();
    const cur = byEmail.get(norm) || '';
    if (!byEmail.has(norm) || nm.length > cur.length) byEmail.set(norm, nm || cur);
  };

  // 1) Ladder directory (playerId -> { email, name, gender })
  try {
    const dir = await getDirectory();
    for (const info of Object.values(dir || {})) remember(info?.email, info?.name);
  } catch (_) { /* ignore */ }

  // 2) Lite ladder accounts (player/<id>.json)
  try {
    const lp = getStore('ladder-players');
    const { blobs } = await lp.list({ prefix: 'player/' });
    const recs = await Promise.all(blobs.map((bl) => lp.get(bl.key, { type: 'json' }).catch(() => null)));
    for (const r of recs) if (r) remember(r.email, r.name);
  } catch (_) { /* ignore */ }

  // 3) Team rosters (team/<id>.json → roster[{ name, email }])
  try {
    const ts = getStore('teams');
    const { blobs } = await ts.list({ prefix: 'team/' });
    const teams = await Promise.all(blobs.map((bl) => ts.get(bl.key, { type: 'json' }).catch(() => null)));
    for (const t of teams) for (const p of (t?.roster || [])) remember(p.email, p.name);
  } catch (_) { /* ignore */ }

  return byEmail;
}

// Every player with a non-zero balance right now, with a display name where one
// can be found (falls back to the email itself in the UI). This is the default
// view for the admin Credits tab — no search required.
async function listActivePeople() {
  const all = await listAll();
  const nonZero = all.filter((r) => r.balanceCents !== 0);
  if (!nonZero.length) return { active: [], totalCents: 0 };
  const index = await buildPeopleIndex();
  const active = nonZero
    .map((r) => ({ email: r.email, name: index.get(r.email) || '', balanceCents: r.balanceCents, updatedAt: r.updatedAt }))
    .sort((a, b) => (b.balanceCents - a.balanceCents) || String(a.name || a.email).localeCompare(String(b.name || b.email)));
  const totalCents = active.reduce((s, a) => s + a.balanceCents, 0);
  return { active, totalCents };
}

// Name-or-email substring search → matches with live credit balances.
async function searchPeople(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const index = await buildPeopleIndex();
  const hits = [];
  for (const [email, name] of index) {
    if (email.includes(q) || String(name).toLowerCase().includes(q)) hits.push({ email, name });
  }
  hits.sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
  const top = hits.slice(0, 50);
  return Promise.all(top.map(async (h) => ({ ...h, balanceCents: (await getCredit(h.email)).balanceCents })));
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const url = new URL(req.url);

  if (req.method === 'GET') {
    const q = url.searchParams.get('q');
    const emailParam = url.searchParams.get('email');

    if (!q && !emailParam) {
      const { active, totalCents } = await listActivePeople();
      return json({ active, count: active.length, totalCents });
    }

    if (q != null && q !== '') {
      const matches = await searchPeople(q);
      return json({ query: q, matches });
    }
    const email = normalizeEmail(emailParam || '');
    if (!email) return json({ error: 'A valid email is required.' }, 400);
    const rec = await getCredit(email);
    return json(annotate({ email, balanceCents: rec.balanceCents, ledger: rec.ledger, updatedAt: rec.updatedAt }));
  }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email || '');
    if (!email) return json({ error: 'A valid email is required.' }, 400);

    if (body.action === 'grant') {
      const cents = Math.round(Number(body.cents) || 0);
      const reason = String(body.reason || '').trim() || 'Admin credit';
      if (cents <= 0) return json({ error: 'Enter a positive dollar amount.' }, 400);
      const rec = await earn(email, cents, reason, { key: `admingrant:${email}:${Date.now()}` });
      return json({ ok: true, ...annotate({ email, balanceCents: rec.balanceCents, ledger: rec.ledger }) });
    }

    if (body.action === 'adjust') {
      const cents = Math.round(Number(body.cents) || 0);
      const reason = String(body.reason || '').trim() || 'Admin adjustment';
      if (!cents) return json({ error: 'Enter a non-zero amount.' }, 400);
      const rec = await adjust(email, cents, reason, { key: `adminadjust:${email}:${Date.now()}` });
      return json({ ok: true, ...annotate({ email, balanceCents: rec.balanceCents, ledger: rec.ledger }) });
    }

    if (body.action === 'void') {
      const reason = String(body.reason || '').trim();
      if (body.all) {
        const res = await voidAll(email, reason || 'Balance voided by admin');
        const rec = res.record;
        return json({ ok: true, noop: !!res.noop, ...annotate({ email, balanceCents: rec.balanceCents, ledger: rec.ledger }) });
      }
      const entryId = String(body.entryId || '').trim();
      if (!entryId) return json({ error: 'entryId (or all:true) is required to void.' }, 400);
      const res = await voidEntry(email, entryId, reason);
      if (res.notFound) return json({ error: 'That credit entry was not found.' }, 404);
      const rec = res.record;
      return json({ ok: true, alreadyVoided: !!res.alreadyVoided, ...annotate({ email, balanceCents: rec.balanceCents, ledger: rec.ledger }) });
    }

    return json({ error: 'unknown action' }, 400);
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/admin-ladder-credits' };
