// =============================================================
// netlify/functions/captain-transfer-request.js
//
// Captain-authenticated endpoint for player transfer requests.
// Captains can request a player be moved to another team.
// Admin reviews and approves/denies via admin-transfer.js.
//
// GET  → list transfer requests involving this team
// POST body: { playerId, toTeamId, note? } → create request
// =============================================================

import { getStore } from '@netlify/blobs';
import { requireCaptain, unauthResponse } from './lib/captain-auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function generateId(prefix) {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async (req) => {
  const auth = await requireCaptain(req);
  if (!auth) return unauthResponse();

  const { team, user } = auth;
  const requestsStore = getStore('transfer-requests');

  // ── GET — list requests for this team ────────────────────────
  if (req.method === 'GET') {
    const { blobs } = await requestsStore.list({ prefix: 'request/' }).catch(() => ({ blobs: [] }));
    const all = await Promise.all(
      blobs.map(b => requestsStore.get(b.key, { type: 'json' }).catch(() => null))
    );
    // Return requests where this team is the source
    const mine = all
      .filter(Boolean)
      .filter(r => r.fromTeamId === team.id)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    return json({ requests: mine });
  }

  // ── POST — create a transfer request ─────────────────────────
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const { playerId, toTeamId, note } = body;
  if (!playerId || !toTeamId) return json({ error: 'playerId and toTeamId required' }, 400);
  if (toTeamId === team.id) return json({ error: 'Destination must be a different team' }, 400);

  // Confirm player is on this team
  const player = (team.roster || []).find(p => p.id === playerId);
  if (!player) return json({ error: 'Player not found on your roster' }, 404);

  // Captains cannot be transferred
  if (player.isCaptain) return json({ error: 'Team captain cannot be transferred. Contact the league admin.' }, 400);

  // Prevent duplicate pending requests for the same player
  const { blobs } = await requestsStore.list({ prefix: 'request/' }).catch(() => ({ blobs: [] }));
  const existing = await Promise.all(
    blobs.map(b => requestsStore.get(b.key, { type: 'json' }).catch(() => null))
  );
  const duplicate = existing.find(
    r => r && r.playerId === playerId && r.fromTeamId === team.id && r.status === 'pending'
  );
  if (duplicate) return json({ error: 'A pending transfer request for this player already exists' }, 409);

  // Fetch destination team name
  const teamsStore = getStore('teams');
  const toTeam = await teamsStore.get(`team/${toTeamId}.json`, { type: 'json' }).catch(() => null);
  if (!toTeam) return json({ error: 'Destination team not found' }, 404);

  const request = {
    id: generateId('tr_'),
    status: 'pending',
    playerId: player.id,
    playerName: player.name,
    fromTeamId: team.id,
    fromTeamName: team.name,
    toTeamId,
    toTeamName: toTeam.name,
    seasonId: team.seasonId || null,
    note: note || null,
    requestedBy: user.email,
    requestedAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
  };

  await requestsStore.setJSON(`request/${request.id}.json`, request);
  return json({ ok: true, request });
};
