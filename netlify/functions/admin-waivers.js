// netlify/functions/admin-waivers.js
// Admin-only waiver compliance + paper-signature override (multi-waiver).
//
// GET ?season=I[&waiverId=league]      → compliance for one waiver (default
//                                          the first active one)
//      &format=csv                     → CSV export for that waiver
// POST action=mark-paper   body { waiverId, playerId }   → record paper signature
// POST action=unmark-paper body { waiverId, playerId }   → remove it
//
// A player counts as signed when their latest signature for that waiver matches
// the current version + season. Method is 'online' or 'paper'.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { circuitCode, isTestTeam } from './lib/circuit.js';
import {
  getAllWaivers, getActiveWaivers, getWaiverById, listSignatures,
  recordSignature, removeSignature,
} from './lib/waiver.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

// Roster of every non-test team in a season → [{playerId,name,email,teamId,teamName,division}]
async function seasonRoster(season) {
  const teamsStore = getStore('teams');
  const { blobs } = await teamsStore.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const players = [];
  for (const b of blobs) {
    const team = await teamsStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!team || isTestTeam(team)) continue;
    if (circuitCode(team.circuit) !== season) continue;
    for (const p of (team.roster || [])) {
      if (!p.id) continue;
      players.push({ playerId: p.id, name: p.name || '', email: p.email || '', teamId: team.id, teamName: team.name || '', division: team.divisionLabel || team.division || '' });
    }
  }
  return players;
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);
  const season = circuitCode((url.searchParams.get('season') || 'I').replace(/^circuit-/i, ''));

  // ── POST: paper-signature override ──
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
    const action = url.searchParams.get('action') || body.action;
    const waiver = await getWaiverById(body.waiverId);
    if (!waiver) return json({ error: 'Waiver not found' }, 404);
    if (!body.playerId) return json({ error: 'playerId required' }, 400);

    if (action === 'mark-paper') {
      // Find the player's name/email from the roster for the audit record.
      const roster = await seasonRoster(season);
      const p = roster.find(x => x.playerId === body.playerId) || {};
      const rec = await recordSignature({
        waiverId: waiver.id, playerId: body.playerId,
        email: p.email || null, name: p.name || null,
        signedName: p.name || 'Paper signature',
        season, version: waiver.version, method: 'paper',
        markedBy: admin.email || 'admin',
      });
      return json({ ok: true, signature: rec });
    }
    if (action === 'unmark-paper') {
      await removeSignature(waiver.id, body.playerId);
      return json({ ok: true });
    }
    return json({ error: 'Unknown action' }, 400);
  }

  // ── GET: compliance ──
  const allWaivers = await getAllWaivers();
  const active = await getActiveWaivers();
  const waiverId = url.searchParams.get('waiverId') || (active[0]?.id) || (allWaivers[0]?.id);
  const waiver = allWaivers.find(w => w.id === waiverId);
  if (!waiver) {
    return json({ waivers: allWaivers.map(w => ({ id: w.id, title: w.title, enabled: w.enabled, version: w.version })), players: [], counts: { signed: 0, total: 0 } });
  }

  try {
    const [signatures, roster] = await Promise.all([listSignatures(waiver.id), seasonRoster(season)]);
    const players = roster.map(p => {
      const sig = signatures[p.playerId] || null;
      const signed = !!sig && sig.version === waiver.version && String(sig.season) === String(season);
      return {
        ...p,
        signed,
        method: signed ? (sig.method || 'online') : null,
        signedName: signed ? (sig.signedName || '') : '',
        signedAt: signed ? (sig.signedAt || '') : '',
        markedBy: signed && sig.method === 'paper' ? (sig.markedBy || '') : '',
      };
    });
    players.sort((a, b) =>
      Number(a.signed) - Number(b.signed) ||
      a.teamName.localeCompare(b.teamName) ||
      a.name.localeCompare(b.name));
    const signedCount = players.filter(p => p.signed).length;

    if ((url.searchParams.get('format') || 'json') === 'csv') {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['Name', 'Email', 'Team', 'Division', 'Signed', 'Method', 'Signed name', 'Signed at', 'Marked by', 'Waiver', 'Version'];
      const lines = [header.map(esc).join(',')];
      for (const p of players) {
        lines.push([p.name, p.email, p.teamName, p.division, p.signed ? 'YES' : 'NO', p.method || '', p.signedName, p.signedAt, p.markedBy, waiver.title, waiver.version].map(esc).join(','));
      }
      return new Response(lines.join('\r\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="waiver-${waiver.id}-season-${season}-v${waiver.version}.csv"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    return json({
      season,
      waivers: allWaivers.map(w => ({ id: w.id, title: w.title, enabled: w.enabled, version: w.version })),
      waiver: { id: waiver.id, title: waiver.title, version: waiver.version, enabled: waiver.enabled },
      counts: { signed: signedCount, total: players.length },
      players,
    });
  } catch (e) {
    console.error('admin-waivers error:', e);
    return json({ error: 'Could not load waiver compliance' }, 500);
  }
};

export const config = { path: '/.netlify/functions/admin-waivers' };
