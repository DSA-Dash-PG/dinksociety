// netlify/functions/admin-roster-approvals.js
//
// ADMIN-ONLY review queue for players captains have asked to add.
//
// Captains can edit and remove their own players freely, but they cannot put a
// new person on a roster unilaterally — captain-roster stamps `pendingAdd` on
// anyone new and they sit inert on the team record until the league rules here.
//
// GET  → { pending: [ { teamId, teamName, circuit, seasonName, playerId, name,
//                       gender, email, phone, dupr, requestedAt, requestedBy,
//                       match } ], count }
//        `match` is set when this person's email already exists elsewhere in the
//        league: { name, teamName, seasonName, playerId }. It is INFORMATION for
//        the admin, not an action — stats follow the email through the identity
//        layer either way, so approving does not have to rewrite any ids.
//
// POST { teamId, playerId, action: 'approve' | 'reject' }
//   approve → clears pendingAdd; they are now on the roster.
//   reject  → removes the entry from the roster entirely.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { circuitCode, seasonName } from './lib/circuit.js';
import { normalizeEmail } from './lib/identity.js';
import { isTestTeam } from './lib/circuit.js';
import { decideRosterAdd, RosterApprovalError } from './lib/roster-approvals.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

async function loadTeams(store) {
  const { blobs } = await store.list({ prefix: 'team/' });
  const teams = await Promise.all(blobs.map(async b => {
    // Strong consistency: a request may have been written seconds ago, and an
    // eventual read would show the admin an empty queue.
    const raw = await store.get(b.key, { type: 'json', consistency: 'strong' }).catch(() => null);
    return raw ? { key: b.key, team: raw } : null;
  }));
  return teams.filter(Boolean);
}

export default async (req) => {
  const admin = await verifyAdminSession(req);
  if (!admin.valid) return unauthResponse(admin.error);

  const store = getStore('teams');

  // ── GET: the queue ──
  if (req.method === 'GET') {
    const all = await loadTeams(store);

    // Everyone already on a roster, keyed by normalized email — used to tell the
    // admin "this looks like the Shay who played for ZERO ZERO TWO".
    const byEmail = new Map();
    for (const { team } of all) {
      for (const p of (team.roster || [])) {
        if (p.pendingAdd) continue;
        const key = p.normalizedEmail || normalizeEmail(p.email);
        if (!key || byEmail.has(key)) continue;
        byEmail.set(key, {
          playerId: p.id || null,
          name: p.name || '',
          teamName: team.name || '',
          seasonName: seasonName(team.circuit || team.seasonId),
        });
      }
    }

    const pending = [];
    for (const { team } of all) {
      if (isTestTeam(team)) continue;
      for (const p of (team.roster || [])) {
        if (!p.pendingAdd) continue;
        const key = p.normalizedEmail || normalizeEmail(p.email);
        pending.push({
          teamId: team.id,
          teamName: team.name || '',
          circuit: circuitCode(team.circuit || team.seasonId),
          seasonName: seasonName(team.circuit || team.seasonId),
          playerId: p.id,
          name: p.name || '',
          gender: p.gender || '',
          email: p.email || '',
          phone: p.phone || '',
          dupr: p.dupr || null,
          requestedAt: p.pendingAddAt || null,
          requestedBy: p.pendingAddBy || null,
          match: key ? (byEmail.get(key) || null) : null,
        });
      }
    }
    pending.sort((a, b) => String(a.requestedAt || '').localeCompare(String(b.requestedAt || '')));
    return json({ pending, count: pending.length });
  }

  // ── POST: rule on one ──
  // The decision itself lives in lib/roster-approvals.js so the one-tap email
  // links (approval-decide.js) and this tab do exactly the same thing.
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
    const { teamId, playerId, action, note } = body || {};
    try {
      const out = await decideRosterAdd({
        teamId, playerId, action, note,
        adminEmail: admin.payload?.email || null,
      });
      return json({ ok: true, action: out.action, playerId: out.playerId, teamId: out.teamId, notified: out.notified });
    } catch (err) {
      if (err instanceof RosterApprovalError) return json({ error: err.message }, err.status);
      console.error('admin-roster-approvals POST error:', err);
      return json({ error: 'Action failed', detail: err.message }, 500);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
};

export const config = { path: '/.netlify/functions/admin-roster-approvals' };
