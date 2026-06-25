// netlify/functions/admin-ladder-save.js
// POST /api/admin-ladder-save  (admin session required)
// Create or update a ladder event. Pass `id` to update; omit to create.
//
// Body: { id?, circuit?, name, date, startTime?, place?, courts?, capacity?,
//         fee? | feeCents?, paymentMethods?, venmoHandle?, waitlist?,
//         spotOpenPolicy?, cancelPolicy?, fcfsWindowHours?, organizers?, status? }

import crypto from 'crypto';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getEvent, setEvent, capacityFromCourts } from './lib/ladder.js';

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
  const methods = Array.isArray(b.paymentMethods) && b.paymentMethods.length
    ? b.paymentMethods.filter(m => ['card', 'venmo', 'credit'].includes(m)) : ['card', 'venmo'];

  // Play format (merged from the old PickleLadder create form):
  // per-court names (top→bottom; index 0 = championship court), round count,
  // round length, and scoring mode. The run-night engine defaults to these.
  const courtNames = Array.isArray(b.courtNames)
    ? b.courtNames.map(s => String(s).trim()).filter(Boolean).slice(0, 20)
    : (existing?.courtNames || []);
  const rounds = Number.isFinite(+b.rounds) && +b.rounds > 0 ? Math.min(20, Math.floor(+b.rounds)) : (existing?.rounds ?? 6);
  const roundMin = Number.isFinite(+b.roundMin) && +b.roundMin > 0 ? Math.min(60, Math.floor(+b.roundMin)) : (existing?.roundMin ?? 12);
  const scoreMode = ['points', 'winby2', 'to11', 'to15'].includes(b.scoreMode) ? b.scoreMode : (existing?.scoreMode || 'points');

  const event = {
    id,
    circuit: b.circuit || existing?.circuit || 'I',
    name: String(b.name).slice(0, 120),
    date: b.date,
    startTime: b.startTime || existing?.startTime || '',
    endTime: b.endTime || existing?.endTime || '',
    place: b.place || existing?.place || '',
    courts,
    courtNames,
    rounds,
    roundMin,
    scoreMode,
    // Display string derived from courtNames, shown in reminder emails.
    courtNumbers: courtNames.length ? courtNames.join(' · ') : (existing?.courtNumbers || null),
    capacity,
    feeCents: Number.isFinite(feeCents) ? feeCents : 0,
    paymentMethods: methods,
    venmoHandle: b.venmoHandle || existing?.venmoHandle || null,
    waitlist: b.waitlist !== false,
    spotOpenPolicy: b.spotOpenPolicy === 'auto' ? 'auto' : 'hold',
    cancelPolicy: ['auto_credit', 'credit_if_refilled', 'no_credit'].includes(b.cancelPolicy) ? b.cancelPolicy : 'auto_credit',
    type: ['mixed', 'mens', 'womens'].includes(b.type) ? b.type : (existing?.type || 'mixed'),
    fcfsWindowHours: Number.isFinite(+b.fcfsWindowHours) ? +b.fcfsWindowHours : (existing?.fcfsWindowHours ?? 24),
    organizers: Array.isArray(b.organizers) ? b.organizers.filter(Boolean) : (existing?.organizers || []),
    status: b.status || existing?.status || 'open',
    createdAt: existing?.createdAt || new Date().toISOString(),
    createdBy: existing?.createdBy || v.payload?.email || null,
  };

  await setEvent(event);
  return json({ ok: true, created: !b.id, event });
};

export const config = { path: '/.netlify/functions/admin-ladder-save' };
