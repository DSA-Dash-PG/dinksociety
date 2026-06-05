// netlify/functions/public-transactions.js
//
// PUBLIC endpoint — no auth. Returns completed transfer/trade transactions
// from the 'transfer-log' blob store for display on team and player pages.
//
// GET /.netlify/functions/public-transactions?teamId=<id>
//   → transactions where the team is the source OR destination
// GET /.netlify/functions/public-transactions?playerId=<id>[&playerName=<name>]
//   → transactions for that player (matched by id, with name fallback)
// GET /.netlify/functions/public-transactions
//   → ALL transactions (league-wide ledger). Filter client-side.
// Optional &season=<seasonId> to scope to one season (default: all seasons).
//
// The internal admin identity (transferredBy) is stripped for privacy.
// The note IS returned (shown publicly).
//
// Log entries are written by admin-transfer.js (executeTransfer).

import { getStore } from '@netlify/blobs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const teamId     = (url.searchParams.get('teamId') || '').trim();
  const playerId   = (url.searchParams.get('playerId') || '').trim();
  const playerName = (url.searchParams.get('playerName') || '').trim();
  const season     = (url.searchParams.get('season') || '').trim();

  // No team/player filter → league-wide ledger (all entries).
  const allEntries = !teamId && !playerId && !playerName;

  try {
    const logStore = getStore('transfer-log');
    const { blobs } = await logStore.list({ prefix: 'entry/' }).catch(() => ({ blobs: [] }));
    const entries = await Promise.all(
      blobs.map(b => logStore.get(b.key, { type: 'json' }).catch(() => null))
    );

    const filtered = entries
      .filter(Boolean)
      .filter(e => {
        if (season && e.seasonId !== season) return false;
        if (allEntries) return true;
        if (teamId) return e.fromTeamId === teamId || e.toTeamId === teamId;
        if (playerId && e.playerId === playerId) return true;
        if (playerName && e.playerName === playerName) return true;
        return false;
      })
      .sort((a, b) => String(b.transferredAt).localeCompare(String(a.transferredAt)))
      // Strip the internal admin email; keep everything else (note included).
      .map(e => ({
        id: e.id,
        playerId: e.playerId,
        playerName: e.playerName,
        fromTeamId: e.fromTeamId,
        fromTeamName: e.fromTeamName,
        toTeamId: e.toTeamId,
        toTeamName: e.toTeamName,
        seasonId: e.seasonId || null,
        note: e.note || null,
        // 'trade' = captain-requested + admin-approved · 'direct' = admin move
        type: e.requestId ? 'trade' : 'direct',
        transferredAt: e.transferredAt,
      }));

    return json({ transactions: filtered });
  } catch (err) {
    console.error('public-transactions error:', err);
    return json({ transactions: [] });
  }
};

export const config = { path: '/.netlify/functions/public-transactions' };
