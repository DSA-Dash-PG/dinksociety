// netlify/functions/admin-organizers.js
// Admin-only. Manage the roster of ladder ORGANIZERS (grant / deny access) and
// approve or deny an organizer ladder into the running Dink Society leaderboard.
//
// GET  /api/admin-organizers
//   → { organizers:[{ email,name,status,..., ladders:[{id,name,date,status,leaderboard}] }],
//       pendingLadders:[{ id,name,date,ownerEmail,status }] }
// POST /api/admin-organizers  { action, ... }
//   invite         { name, email }  → grant: create/activate an organizer (+ a lite
//                                      player account so their magic-link resolves)
//   suspend        { email }        → deny access  (status:'suspended')
//   activate       { email }        → restore access (status:'active')
//   remove         { email }        → delete the organizer record
//   approve-ladder { eventId }      → event.leaderboard = 'included'
//   deny-ladder    { eventId }      → event.leaderboard = 'excluded'

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { listOrganizers, getOrganizer, setOrganizer, deleteOrganizer } from './lib/organizers.js';
import { listEvents, getEvent, setEvent } from './lib/ladder.js';
import { createLitePlayer } from './lib/ladder-players.js';
import { normalizeEmail } from './lib/identity.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  if (req.method === 'GET') {
    const [orgs, events] = await Promise.all([listOrganizers(), listEvents().catch(() => [])]);
    const byOwner = {};
    for (const e of events) {
      const o = normalizeEmail(e.ownerEmail);
      if (!o) continue;
      (byOwner[o] = byOwner[o] || []).push({
        id: e.id, name: e.name, date: e.date, status: e.status, leaderboard: e.leaderboard || 'included',
      });
    }
    const organizers = orgs.map(o => ({ ...o, ladders: byOwner[o.email] || [] }));
    const pendingLadders = events
      .filter(e => e.leaderboard === 'pending' && normalizeEmail(e.ownerEmail))
      .map(e => ({ id: e.id, name: e.name, date: e.date, ownerEmail: e.ownerEmail, status: e.status }))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    return json({ organizers, pendingLadders });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const b = await req.json().catch(() => ({}));

  switch (b.action) {
    case 'invite': {
      const email = normalizeEmail(b.email);
      const name = String(b.name || '').trim().slice(0, 80);
      if (!email) return json({ error: 'A valid email is required.' }, 400);
      // Ensure a login identity exists so the player magic-link resolves for a
      // brand-new organizer who isn't on any team.
      let playerId = null;
      try { const { record } = await createLitePlayer({ name, email }); playerId = record.playerId; } catch { /* non-fatal */ }
      const existing = await getOrganizer(email);
      const rec = await setOrganizer({
        email,
        name: name || existing?.name || '',
        status: 'active',
        playerId: playerId || existing?.playerId || null,
        invitedAt: existing?.invitedAt || new Date().toISOString(),
        invitedBy: existing?.invitedBy || v.payload.email,
      });
      return json({ ok: true, organizer: rec });
    }
    case 'suspend':
    case 'activate': {
      const rec = await getOrganizer(b.email);
      if (!rec) return json({ error: 'Organizer not found.' }, 404);
      rec.status = b.action === 'suspend' ? 'suspended' : 'active';
      await setOrganizer(rec);
      return json({ ok: true, organizer: rec });
    }
    case 'remove': {
      await deleteOrganizer(b.email);
      return json({ ok: true });
    }
    case 'approve-ladder':
    case 'deny-ladder': {
      const event = await getEvent(b.eventId);
      if (!event) return json({ error: 'Ladder not found.' }, 404);
      event.leaderboard = b.action === 'approve-ladder' ? 'included' : 'excluded';
      await setEvent(event);
      return json({ ok: true, event: { id: event.id, leaderboard: event.leaderboard } });
    }
    default:
      return json({ error: 'Unknown action' }, 400);
  }
};

export const config = { path: '/.netlify/functions/admin-organizers' };
