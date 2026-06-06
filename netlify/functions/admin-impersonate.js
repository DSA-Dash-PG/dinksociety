// netlify/functions/admin-impersonate.js
// Lets an authenticated admin "view as" a team's captain/co-captain or any
// rostered player WITHOUT touching the roster. Mints a real captain or player
// session (same shape the auth guards expect) plus a JS-readable ds_view_as
// cookie so the captain/player pages can show an impersonation banner.
//
// POST { mode: 'captain'|'player', teamId, email?, playerId? }
//   captain mode: email = leader email (defaults to team.captainEmail)
//   player mode:  playerId = roster entry id
// → { ok: true, redirect: '/captain.html' | '/me.html' }
//
// Impersonation sessions expire after 4 hours (vs 30 days for real logins).

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';
import { getTeamById, leaderRole } from './lib/captain-auth.js';

const IMPERSONATE_HOURS = 4;

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let admin;
  try {
    admin = await requireAdmin(req);
  } catch {
    return unauthResponse();
  }

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const { mode, teamId, playerId } = body || {};

  const team = await getTeamById(teamId);
  if (!team) return jsonError(404, 'Team not found');

  const now = Date.now();
  const expiresAt = new Date(now + IMPERSONATE_HOURS * 60 * 60 * 1000).toISOString();
  const createdAt = new Date(now).toISOString();
  const maxAge = IMPERSONATE_HOURS * 60 * 60;

  let sessionCookie, viewAs, redirect;

  if (mode === 'captain') {
    const email = (body.email || team.captainEmail || '').toLowerCase();
    const role = leaderRole(team, email);
    if (!role) return jsonError(400, 'That email is not a captain or co-captain of this team');

    const sessionId = randomId(20);
    await getStore('captain-sessions').setJSON(`session/${sessionId}.json`, {
      id: sessionId,
      teamId: team.id,
      email,
      createdAt,
      expiresAt,
      impersonatedBy: admin.email, // audit trail; guards ignore extra fields
    });

    sessionCookie = cookie('ds_captain_session', sessionId, maxAge, true);
    const leader = (team.roster || []).find(p => (p.email || '').toLowerCase() === email);
    viewAs = { mode: 'captain', role, name: leader?.name || email, team: team.name };
    redirect = '/captain.html';

  } else if (mode === 'player') {
    const player = (team.roster || []).find(p => p.id === playerId);
    if (!player) return jsonError(404, 'Player not found on this roster');

    // requirePlayer only enforces email match when the roster entry has one.
    const email = (player.normalizedEmail || player.email || admin.email || '').toLowerCase();

    const sessionId = randomId(20);
    await getStore('player-sessions').setJSON(`session/${sessionId}.json`, {
      id: sessionId,
      playerId: player.id,
      teamId: team.id,
      email,
      createdAt,
      expiresAt,
      impersonatedBy: admin.email,
    });

    sessionCookie = cookie('ds_player_session', sessionId, maxAge, true);
    viewAs = { mode: 'player', name: player.name, team: team.name };
    redirect = '/me.html';

  } else {
    return jsonError(400, 'mode must be "captain" or "player"');
  }

  console.log(`[impersonate] ${admin.email} → ${viewAs.mode} "${viewAs.name}" (${team.name})`);

  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', sessionCookie);
  // JS-readable (NOT HttpOnly) so the page can render the banner.
  headers.append('Set-Cookie',
    cookie('ds_view_as', encodeURIComponent(JSON.stringify(viewAs)), maxAge, false));

  return new Response(JSON.stringify({ ok: true, redirect, viewAs }), { status: 200, headers });
};

function cookie(name, value, maxAge, httpOnly) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (httpOnly) parts.splice(1, 0, 'HttpOnly');
  return parts.join('; ');
}

function jsonError(status, error) {
  return new Response(JSON.stringify({ error }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const config = { path: '/.netlify/functions/admin-impersonate' };
