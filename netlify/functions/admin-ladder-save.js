// netlify/functions/admin-ladder-save.js
// POST /api/admin-ladder-save  (admin session required)
// Create or update a ladder event. Pass `id` to update; omit to create.
//
// Body: { id?, circuit?, name, date, startTime?, place?, address?, courts?, capacity?,
//         fee? | feeCents?, paymentMethods?, venmoHandle?, waitlist?,
//         spotOpenPolicy?, cancelPolicy?, fcfsWindowHours?, organizers?, status?,
//         description?, rules?, adminNotes? }
//
// description / rules — markdown, shown publicly on ladders.html. Empty string clears.
// adminNotes — private to admins/organizers; never exposed by public-ladders.js.

import crypto from 'crypto';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getEvent, setEvent, capacityFromCourts } from './lib/ladder.js';
import { announceNewLadder } from './lib/ladder-announce.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const b = await req.json().catch(() => ({}));
  if (!b.name || !b.date) return json({ error: 'name and date are required' }, 400);

  const id = b.id || crypto.randomBytes(6).toString('hex');
  const existing = b.id ? await getEvent(b.id) : null;

  const courts = Math.max(0, Math.floor(Number(b.courts) || 0));
  const feeCents = b.feeCents != null ? Math.round(Number(b.feeCents)) : Math.round((Number(b.fee) || 0) * 100);
  const capacity = b.capacity != null && +b.capacity > 0 ? Math.floor(+b.capacity) : capacityFromCourts(courts);
  // On update, an omitted paymentMethods must KEEP the existing setting — the old
  // default here silently re-enabled card on every edit of a Venmo-only ladder.
  const methods = Array.isArray(b.paymentMethods) && b.paymentMethods.length
    ? b.paymentMethods.filter(m => ['card', 'venmo', 'credit', 'free'].includes(m))
    : (existing?.paymentMethods?.length ? existing.paymentMethods : ['card', 'venmo']);
  // Preserve an organizer's free/private settings on an admin-side edit (e.g.
  // approving a ladder in the admin panel) unless explicitly overridden here.
  const isFree = b.free != null ? !!b.free : !!existing?.free;
  const visibility = ['public', 'private'].includes(b.visibility) ? b.visibility : (existing?.visibility || 'public');

  // Play format (merged from the old PickleLadder create form):
  // per-court names (top→bottom; index 0 = championship court), round count,
  // round length, and scoring mode. The run-night engine defaults to these.
  const courtNames = Array.isArray(b.courtNames)
    ? b.courtNames.map(s => String(s).trim()).filter(Boolean).slice(0, 20)
    : (existing?.courtNames || []);
  const rounds = Number.isFinite(+b.rounds) && +b.rounds > 0 ? Math.min(20, Math.floor(+b.rounds)) : (existing?.rounds ?? 10);
  const roundMin = Number.isFinite(+b.roundMin) && +b.roundMin > 0 ? Math.min(60, Math.floor(+b.roundMin)) : (existing?.roundMin ?? 12);
  const scoreMode = ['points', 'winby2', 'to11', 'to15'].includes(b.scoreMode) ? b.scoreMode : (existing?.scoreMode || 'points');

  // Free-form descriptive fields (added 2026-08-13). Length caps stop a runaway
  // paste from bloating the blob; markdown is rendered client-side.
  const clip = (s, max) => (s == null ? '' : String(s).slice(0, max));
  const description = b.description !== undefined ? clip(b.description, 8000) : (existing?.description || '');
  const rules       = b.rules       !== undefined ? clip(b.rules,       8000) : (existing?.rules       || '');
  const adminNotes  = b.adminNotes  !== undefined ? clip(b.adminNotes,  4000) : (existing?.adminNotes  || '');

  const event = {
    id,
    circuit: b.circuit || existing?.circuit || 'I',
    name: String(b.name).slice(0, 120),
    date: b.date,
    startTime: b.startTime || existing?.startTime || '',
    endTime: b.endTime || existing?.endTime || '',
    place: b.place || existing?.place || '',
    address: b.address || existing?.address || '',
    courts,
    courtNames,
    rounds,
    roundMin,
    scoreMode,
    // Display string derived from courtNames, shown in reminder emails.
    courtNumbers: courtNames.length ? courtNames.join(' · ') : (existing?.courtNumbers || null),
    capacity,
    feeCents: isFree ? 0 : (Number.isFinite(feeCents) ? feeCents : 0),
    paymentMethods: isFree ? ['free'] : methods,
    venmoHandle: isFree ? null : (b.venmoHandle || existing?.venmoHandle || null),
    free: isFree,
    visibility,
    waitlist: b.waitlist !== false,
    spotOpenPolicy: b.spotOpenPolicy === 'auto' ? 'auto' : 'hold',
    // Default is no refund/no credit — a cancelled spot just reopens. Existing
    // events keep whatever they had on an edit that omits this field.
    cancelPolicy: ['auto_credit', 'credit_if_refilled', 'no_credit'].includes(b.cancelPolicy) ? b.cancelPolicy : (existing?.cancelPolicy || 'no_credit'),
    type: ['mixed', 'mens', 'womens'].includes(b.type) ? b.type : (existing?.type || 'mixed'),
    // Format 'fixed-partner': signups register a locked pair that stays
    // teamed up all night (see lib/ladder-scoring.js genR1Pairs/genNRPairs) —
    // default 'individual' (the original per-round re-paired model).
    format: ['individual', 'fixed-partner'].includes(b.format) ? b.format : (existing?.format || 'individual'),
    // DUPR-rated ladders collect a DUPR ID at signup and prompt players to
    // join the club (see ladder-signup.js / public/ladders.html signup UI).
    duprRated: b.duprRated != null ? !!b.duprRated : !!existing?.duprRated,
    // Descriptive content (public: description, rules · private: adminNotes)
    description,
    rules,
    adminNotes,
    fcfsWindowHours: Number.isFinite(+b.fcfsWindowHours) ? +b.fcfsWindowHours : (existing?.fcfsWindowHours ?? 24),
    organizers: Array.isArray(b.organizers) ? b.organizers.filter(Boolean) : (existing?.organizers || []),
    // Ladder ownership (organizer portal). Admin-created ladders have no owner
    // (null); editing an organizer's ladder here preserves their ownership.
    ownerEmail: existing?.ownerEmail || null,
    // Running-leaderboard inclusion. Admin ladders default 'included' (unchanged
    // behavior); organizer ladders arrive 'pending' and are preserved on edit
    // unless the admin explicitly passes a new value.
    leaderboard: ['included', 'pending', 'excluded'].includes(b.leaderboard) ? b.leaderboard : (existing?.leaderboard || 'included'),
    status: b.status || existing?.status || 'open',
    createdAt: existing?.createdAt || new Date().toISOString(),
    createdBy: existing?.createdBy || v.payload?.email || null,
    // Fire-once flag: set when the "new ladder open" blast goes out so a later
    // edit (which re-runs this same endpoint) never re-announces. Preserved on update.
    announcedAt: existing?.announcedAt || null,
  };

  const isNew = !b.id;

  // Announce a brand-new, open ladder to all past players — exactly once.
  // Done before the final save so `announcedAt` is persisted with the event.
  // Email failure never blocks creation (announceNewLadder never throws).
  let announced = null;
  if (isNew && event.status === 'open' && !event.announcedAt) {
    announced = await announceNewLadder(event);
    if (announced && announced.sent > 0) event.announcedAt = new Date().toISOString();
  }

  await setEvent(event);
  return json({ ok: true, created: isNew, event, announced });
};

export const config = { path: '/.netlify/functions/admin-ladder-save' };
