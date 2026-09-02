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
import { logActivity } from './lib/activity-log.js';
import { sendEmail, renderRosterAddDecision } from './lib/email.js';

const VALID_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.app';
}

/**
 * Who hears about this decision: the captain, any co-captains, and whoever
 * actually submitted the request (a co-captain may have added them). Deduped,
 * lowercased, and never sent to an empty address.
 */
function leaderEmails(team, requestedBy) {
  const set = new Set();
  const add = (e) => { const x = String(e || '').trim().toLowerCase(); if (x && x.includes('@')) set.add(x); };
  add(team.captainEmail);
  for (const p of (team.roster || [])) {
    if ((p.isCaptain || p.isCoCaptain) && p.email) add(p.email);
  }
  add(requestedBy);
  return [...set];
}

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
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
    const { teamId, playerId, action } = body || {};
    if (!VALID_ID.test(String(teamId || ''))) return json({ error: 'teamId required' }, 400);
    if (!VALID_ID.test(String(playerId || ''))) return json({ error: 'playerId required' }, 400);
    if (!['approve', 'reject'].includes(action)) return json({ error: 'action must be approve or reject' }, 400);

    const key = `team/${teamId}.json`;
    const team = await store.get(key, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!team) return json({ error: 'Team not found' }, 404);

    const roster = Array.isArray(team.roster) ? team.roster : [];
    const player = roster.find(p => p && p.id === playerId);
    if (!player) return json({ error: 'Player not found on this team' }, 404);
    if (!player.pendingAdd) return json({ error: 'That player is not awaiting approval' }, 409);

    const requestedBy = player.pendingAddBy || null;

    if (action === 'approve') {
      delete player.pendingAdd;
      delete player.pendingAddAt;
      delete player.pendingAddBy;
      player.approvedAt = new Date().toISOString();
      player.approvedBy = admin.payload?.email || 'admin';
      team.roster = roster;
    } else {
      team.roster = roster.filter(p => p.id !== playerId);
    }

    team.rosterUpdatedAt = new Date().toISOString();
    await store.setJSON(key, team);

    // Tell the captain. A request that vanishes without a word is worse than no
    // approval step at all — they'd re-add the player and wonder why nothing
    // sticks. Email is best-effort: a send failure must not undo the decision.
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 400) : '';
    const to = leaderEmails(team, requestedBy);
    if (to.length) {
      const html = renderRosterAddDecision({
        approved: action === 'approve',
        playerName: player.name || 'Your player',
        teamName: team.name || 'your team',
        teamEmoji: team.emoji || '',
        seasonName: seasonName(team.circuit || team.seasonId),
        note,
        portalUrl: `${siteUrl()}/captain.html`,
        adminEmail: 'dink@dinksociety.app',
      });
      const subject = action === 'approve'
        ? `${player.name || 'Your player'} is on your ${team.name || 'team'} roster`
        : `Roster request declined \u2014 ${player.name || 'your player'}`;
      try {
        await sendEmail({ to, subject, html, replyTo: 'dink@dinksociety.app' });
      } catch (err) {
        console.error('roster-approval email failed:', err?.message || err);
      }
    }

    await logActivity({
      type: action === 'approve' ? 'roster.add.approved' : 'roster.add.rejected',
      actor: { email: admin.payload?.email || null, role: 'admin' },
      target: { teamId, teamName: team.name || '', playerId, playerName: player.name || '' },
    }).catch(() => {});

    return json({ ok: true, action, playerId, teamId, notified: to.length });
  }

  return json({ error: 'Method not allowed' }, 405);
};

export const config = { path: '/.netlify/functions/admin-roster-approvals' };
