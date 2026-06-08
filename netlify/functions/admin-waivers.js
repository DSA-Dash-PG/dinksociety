// netlify/functions/admin-waivers.js
// Admin-only waiver compliance view.
//
// GET ?season=I            → { version, season, enabled, counts:{signed,total},
//                              players:[{ playerId, name, email, teamId, teamName,
//                                         division, signed, signedName, signedAt }] }
// GET ?season=I&format=csv → CSV export of the same rows.
//
// A player counts as signed when their latest signature matches BOTH the
// current waiver version AND the active season.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { circuitCode, isTestTeam } from './lib/circuit.js';
import { getWaiverConfig, listSignatures } from './lib/waiver.js';

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  const url = new URL(req.url);
  const seasonParam = url.searchParams.get('season') || 'I';
  const season = circuitCode(seasonParam.replace(/^circuit-/i, ''));
  const format = url.searchParams.get('format') || 'json';

  try {
    const [config, signatures] = await Promise.all([getWaiverConfig(), listSignatures()]);

    // Roster across all (non-test) teams in this season.
    const teamsStore = getStore('teams');
    const { blobs } = await teamsStore.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
    const players = [];
    for (const b of blobs) {
      const team = await teamsStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!team || isTestTeam(team)) continue;
      if (circuitCode(team.circuit) !== season) continue;
      for (const p of (team.roster || [])) {
        if (!p.id) continue;
        const sig = signatures[p.id] || null;
        const signed = !!sig && sig.version === config.version && String(sig.season) === String(season);
        players.push({
          playerId: p.id,
          name: p.name || '',
          email: p.email || '',
          teamId: team.id,
          teamName: team.name || '',
          division: team.divisionLabel || team.division || '',
          signed,
          signedName: signed ? (sig.signedName || '') : '',
          signedAt: signed ? (sig.signedAt || '') : '',
        });
      }
    }

    players.sort((a, b) =>
      Number(a.signed) - Number(b.signed) ||                       // unsigned first
      a.teamName.localeCompare(b.teamName) ||
      a.name.localeCompare(b.name));

    const signedCount = players.filter(p => p.signed).length;

    if (format === 'csv') {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['Name', 'Email', 'Team', 'Division', 'Signed', 'Signed name', 'Signed at', 'Version'];
      const lines = [header.map(esc).join(',')];
      for (const p of players) {
        lines.push([p.name, p.email, p.teamName, p.division, p.signed ? 'YES' : 'NO', p.signedName, p.signedAt, config.version].map(esc).join(','));
      }
      return new Response(lines.join('\r\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="waivers-season-${season}-v${config.version}.csv"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    return json({
      season,
      version: config.version,
      enabled: config.enabled,
      title: config.title,
      counts: { signed: signedCount, total: players.length },
      players,
    });
  } catch (e) {
    console.error('admin-waivers error:', e);
    return json({ error: 'Could not load waiver compliance' }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-waivers' };
