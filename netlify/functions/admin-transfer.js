// =============================================================
// netlify/functions/admin-transfer.js
//
// Admin-only transfer management. Captains submit requests via
// captain-transfer-request.js; admins approve/deny here.
//
// GET  ?status=pending|all     → list transfer requests
// GET  ?log=1                  → list completed transfer log
// POST action=approve          body: { requestId, reviewNote? }
// POST action=deny             body: { requestId, reviewNote? }
// POST action=direct           body: { fromTeamId, toTeamId, playerId, note? }
//   Direct transfer bypasses the request flow (admin-only shortcut)
// =============================================================

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';

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

async function getTeam(store, teamId) {
  return await store.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
}

async function executeTransfer({ teamsStore, logStore, fromTeam, toTeam, player, transferredBy, note, requestId = null }) {
  const now = new Date().toISOString();

  // Remove from source roster
  fromTeam.roster = (fromTeam.roster || []).filter(p => p.id !== player.id);
  fromTeam.updatedAt = now;
  fromTeam.updatedBy = transferredBy;
  await teamsStore.setJSON(`team/${fromTeam.id}.json`, fromTeam);

  // Add to destination roster (clear captain/co-captain flags on transfer)
  const transferredPlayer = { ...player, isCaptain: false, isCoCaptain: false, transferredFrom: fromTeam.id };
  toTeam.roster = [...(toTeam.roster || []), transferredPlayer];
  toTeam.updatedAt = now;
  toTeam.updatedBy = transferredBy;
  await teamsStore.setJSON(`team/${toTeam.id}.json`, toTeam);

  // Write log entry
  const logEntry = {
    id: generateId('tx_'),
    requestId,
    playerId: player.id,
    playerName: player.name,
    fromTeamId: fromTeam.id,
    fromTeamName: fromTeam.name,
    toTeamId: toTeam.id,
    toTeamName: toTeam.name,
    seasonId: fromTeam.seasonId || null,
    note: note || null,
    transferredBy,
    transferredAt: now,
  };
  await logStore.setJSON(`entry/${logEntry.id}.json`, logEntry);
  return logEntry;
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);
  const teamsStore = getStore('teams');
  const requestsStore = getStore('transfer-requests');
  const logStore = getStore('transfer-log');

  // ── GET ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    // Return transfer log
    if (url.searchParams.get('log') === '1') {
      const { blobs } = await requestsStore.list({ prefix: 'entry/' }).catch(() => ({ blobs: [] }));
      // Actually read from logStore
      const logBlobs = await logStore.list({ prefix: 'entry/' }).catch(() => ({ blobs: [] }));
      const entries = await Promise.all(
        logBlobs.blobs.map(b => logStore.get(b.key, { type: 'json' }).catch(() => null))
      );
      const sorted = entries.filter(Boolean).sort((a, b) => b.transferredAt.localeCompare(a.transferredAt));
      return json({ entries: sorted });
    }

    // Return transfer requests
    const statusFilter = url.searchParams.get('status') || 'pending';
    const { blobs } = await requestsStore.list({ prefix: 'request/' }).catch(() => ({ blobs: [] }));
    const requests = await Promise.all(
      blobs.map(b => requestsStore.get(b.key, { type: 'json' }).catch(() => null))
    );
    const filtered = requests
      .filter(Boolean)
      .filter(r => statusFilter === 'all' || r.status === statusFilter)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    return json({ requests: filtered });
  }

  // ── POST ─────────────────────────────────────────────────────
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  const action = body.action;

  // ── Approve request ──────────────────────────────────────────
  if (action === 'approve') {
    const { requestId, reviewNote } = body;
    if (!requestId) return json({ error: 'requestId required' }, 400);

    const request = await requestsStore.get(`request/${requestId}.json`, { type: 'json' }).catch(() => null);
    if (!request) return json({ error: 'Request not found' }, 404);
    if (request.status !== 'pending') return json({ error: `Request is already ${request.status}` }, 400);

    // New-team requests: admin handles team creation manually, just log and mark approved
    if (request.toTeamId === '__new__') {
      request.status = 'approved';
      request.reviewedBy = admin.email;
      request.reviewedAt = new Date().toISOString();
      request.reviewNote = reviewNote || `New team "${request.newTeamName}" — create team manually and complete transfer.`;
      await requestsStore.setJSON(`request/${request.id}.json`, request);
      return json({ ok: true, newTeamRequest: true, note: request.reviewNote });
    }

    const fromTeam = await getTeam(teamsStore, request.fromTeamId);
    const toTeam = await getTeam(teamsStore, request.toTeamId);
    if (!fromTeam) return json({ error: 'Source team not found' }, 404);
    if (!toTeam) return json({ error: 'Destination team not found' }, 404);

    const player = (fromTeam.roster || []).find(p => p.id === request.playerId);
    if (!player) return json({ error: 'Player not found on source team' }, 404);

    const logEntry = await executeTransfer({
      teamsStore, logStore, fromTeam, toTeam, player,
      transferredBy: admin.email,
      note: reviewNote || request.note || null,
      requestId,
    });

    // Mark request approved
    request.status = 'approved';
    request.reviewedBy = admin.email;
    request.reviewedAt = new Date().toISOString();
    request.reviewNote = reviewNote || null;
    await requestsStore.setJSON(`request/${requestId}.json`, request);

    return json({ ok: true, logEntry });
  }

  // ── Deny request ─────────────────────────────────────────────
  if (action === 'deny') {
    const { requestId, reviewNote } = body;
    if (!requestId) return json({ error: 'requestId required' }, 400);

    const request = await requestsStore.get(`request/${requestId}.json`, { type: 'json' }).catch(() => null);
    if (!request) return json({ error: 'Request not found' }, 404);
    if (request.status !== 'pending') return json({ error: `Request is already ${request.status}` }, 400);

    request.status = 'denied';
    request.reviewedBy = admin.email;
    request.reviewedAt = new Date().toISOString();
    request.reviewNote = reviewNote || null;
    await requestsStore.setJSON(`request/${requestId}.json`, request);

    return json({ ok: true });
  }

  // ── Direct transfer (admin shortcut, no prior request needed) ─
  if (action === 'direct') {
    const { fromTeamId, toTeamId, playerId, note } = body;
    if (!fromTeamId || !toTeamId || !playerId) return json({ error: 'fromTeamId, toTeamId, playerId required' }, 400);
    if (fromTeamId === toTeamId) return json({ error: 'Source and destination must differ' }, 400);

    const fromTeam = await getTeam(teamsStore, fromTeamId);
    const toTeam = await getTeam(teamsStore, toTeamId);
    if (!fromTeam) return json({ error: 'Source team not found' }, 404);
    if (!toTeam) return json({ error: 'Destination team not found' }, 404);

    const player = (fromTeam.roster || []).find(p => p.id === playerId);
    if (!player) return json({ error: 'Player not found on source team' }, 404);

    const logEntry = await executeTransfer({
      teamsStore, logStore, fromTeam, toTeam, player,
      transferredBy: admin.email,
      note: note || null,
      requestId: null,
    });

    return json({ ok: true, logEntry });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
};
