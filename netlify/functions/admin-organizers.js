// netlify/functions/admin-organizers.js
// Admin-only. Manage the roster of ladder ORGANIZERS (grant / deny access) and
// approve or deny an organizer ladder into the running Dink Society leaderboard.
//
// GET  /api/admin-organizers
//   → { organizers:[{ email,name,status,..., roles:{leaguePlayer,captain,admin},
//                     ladders:[{id,name,date,status,leaderboard}] }],
//       pendingLadders:[{ id,name,date,ownerEmail,status }] }
// POST /api/admin-organizers  { action, ... }
//   invite         { name, email }  → grant: create/activate an organizer. Provisions a
//                                      lite player account ONLY if the email isn't already a
//                                      league player (captain/rostered players keep their one identity).
//   suspend        { email }        → deny access  (status:'suspended')
//   activate       { email }        → restore access (status:'active')
//   remove         { email }        → delete the organizer record
//   approve-ladder { eventId }      → event.leaderboard = 'included'
//   deny-ladder    { eventId }      → event.leaderboard = 'excluded'

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { isAdminEmail } from './lib/admin-auth.js';
import { listOrganizers, getOrganizer, setOrganizer, deleteOrganizer } from './lib/organizers.js';
import { listEvents, getEvent, setEvent } from './lib/ladder.js';
import { createLitePlayer } from './lib/ladder-players.js';
import { findPlayerByEmail } from './lib/player-auth.js';
import { isTestTeam } from './lib/circuit.js';
import { normalizeEmail } from './lib/identity.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// One pass over the teams store → the set of emails that are rostered league
// players and the set that lead a team (captain OR co-captain). Lets the admin
// see at a glance when a ladder host also wears a league hat. Test-season teams
// are skipped so they can't produce false "captain" badges.
async function leagueRoleSets() {
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
  const rostered = new Set();
  const leaders = new Set();
  for (const team of teams) {
    if (!team || isTestTeam(team)) continue;
    const cap = normalizeEmail(team.captainEmail);
    if (cap) leaders.add(cap);
    for (const p of team.roster || []) {
      const pe = p.normalizedEmail || normalizeEmail(p.email);
      if (!pe) continue;
      rostered.add(pe);
      if (p.isCaptain || p.isCoCaptain) leaders.add(pe);
    }
  }
  return { rostered, leaders };
}

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  if (req.method === 'GET') {
    const [orgs, events, roleSets] = await Promise.all([
      listOrganizers(),
      listEvents().catch(() => []),
      leagueRoleSets(),
    ]);
    const { rostered, leaders } = roleSets;
    const byOwner = {};
    for (const e of events) {
      const o = normalizeEmail(e.ownerEmail);
      if (!o) continue;
      (byOwner[o] = byOwner[o] || []).push({
        id: e.id, name: e.name, date: e.date, status: e.status, leaderboard: e.leaderboard || 'included',
      });
    }
    const organizers = orgs.map(o => ({
      ...o,
      ladders: byOwner[o.email] || [],
      roles: {
        leaguePlayer: rostered.has(o.email),
        captain: leaders.has(o.email),
        admin: isAdminEmail(o.email),
      },
    }));
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
      // Only provision a lite ladder account when the email has NO existing
      // identity. A captain or rostered league player already resolves through
      // findPlayerByEmail, so they keep their single account — no duplicate lite record.
      const existingPlayer = await findPlayerByEmail(email).catch(() => null);
      let playerId = existingPlayer?.playerId || null;
      if (!existingPlayer) {
        try { const { record } = await createLitePlayer({ name, email }); playerId = record.playerId; } catch { /* non-fatal */ }
      }
      const existing = await getOrganizer(email);
      const rec = await setOrganizer({
        email,
        name: name || existing?.name || existingPlayer?.name || '',
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
