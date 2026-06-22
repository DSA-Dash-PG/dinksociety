// =============================================================
// GET /api/admin-players
//
// ADMIN-ONLY master list of every league player with contact details:
// team, name, email, phone, and last-login. One row per roster entry
// (a player on two teams appears once per team).
//
// Scope (per product decision):
//   • Excludes the test/demo season (isTestTeam).
//   • INCLUDES archived / removed players (flagged `archived: true`) so the
//     admin has every contact, not just the active roster.
//
// Last-login is joined from the activity-log `seen/<email>.json` records
// (the same source the Analytics tab uses).
// =============================================================

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { isTestTeam } from './lib/circuit.js';
import { normalizeEmail } from './lib/identity.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  // ── Login activity: seen/<email>.json → { email, lastLoginAt, lastSeenAt } ──
  const actStore = getStore('activity-log');
  const { blobs: seenBlobs } = await actStore.list({ prefix: 'seen/' }).catch(() => ({ blobs: [] }));
  const seen = (await Promise.all(
    seenBlobs.map(b => actStore.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(Boolean);
  const loginByEmail = new Map();
  for (const s of seen) {
    if (!s.email) continue;
    loginByEmail.set(String(s.email).toLowerCase(), { lastLoginAt: s.lastLoginAt || null, lastSeenAt: s.lastSeenAt || null });
  }

  // ── Teams (exclude test/demo), flatten rosters incl. archived players ──
  const teamsStore = getStore('teams');
  const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = (await Promise.all(
    teamBlobs.map(b => teamsStore.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(t => t && !isTestTeam(t));

  const players = [];
  for (const t of teams) {
    const capEmail = (t.captainEmail || '').toLowerCase();
    for (const p of (t.roster || [])) {
      const email = (p.email || '').trim();
      const norm = (p.normalizedEmail || normalizeEmail(email) || email.toLowerCase());
      const login = norm ? loginByEmail.get(norm) : null;
      const isCaptain = capEmail
        ? email.toLowerCase() === capEmail
        : (p.role === 'captain' || p.isCaptain === true);
      players.push({
        playerId: p.id || null,
        name: p.name || '',
        teamId: t.id,
        teamName: t.name || '',
        division: t.division || null,
        divisionLabel: t.divisionLabel || t.division || null,
        seasonId: t.seasonId || null,
        isCaptain,
        isCoCaptain: p.isCoCaptain === true,
        archived: p.archived === true,
        gender: p.gender || null,
        email: email || null,
        phone: p.phone || null,
        lastLoginAt: login?.lastLoginAt || null,
      });
    }
  }

  players.sort((a, b) => a.name.localeCompare(b.name));

  const stats = {
    total: players.length,
    archived: players.filter(p => p.archived).length,
    withPhone: players.filter(p => p.phone).length,
    neverLoggedIn: players.filter(p => !p.lastLoginAt).length,
  };

  return json({ players, stats });
};

export const config = { path: '/.netlify/functions/admin-players' };
