// netlify/functions/admin-shirt-sizes.js
// League-wide shirt sizes for ordering.
//
//   GET [?circuit=II|all] [&format=csv]
//        → { circuit, tally, rows: [{ name, team, division, gender, email, playerId, isSub, size, cut, by, updatedAt }] }
//        One row per PERSON on an active roster of the chosen season (default:
//        the live season). circuit=all covers every season's rosters.
//   POST { email?, playerId?, size, cut? }   → set someone's size for them
//   POST { email?, playerId?, size: null }   → clear it

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { loadAllTeams, seasonOrder } from './lib/league-players.js';
import { circuitCode, seasonName } from './lib/circuit.js';
import { liveCircuit } from './lib/current-season.js';
import { activeRoster } from './lib/roster.js';
import { cleanSize, cleanCut, getAllSizes, lookupSize, setSize, sizeKey, tally, SIZES, CUTS } from './lib/shirt-sizes.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (!body.email && !body.playerId) return json({ error: 'email or playerId required' }, 400);
    if (body.size == null || body.size === '') {
      await setSize({ email: body.email, playerId: body.playerId }, { size: null }, 'admin');
      return json({ ok: true, size: null, cut: null });
    }
    const size = cleanSize(body.size);
    if (!size) return json({ error: 'Unknown size.' }, 400);
    const rec = await setSize({ email: body.email, playerId: body.playerId }, { size, cut: cleanCut(body.cut) }, 'admin');
    return json({ ok: true, size: rec.size, cut: rec.cut });
  }
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const url = new URL(req.url);
  const want = url.searchParams.get('circuit');
  const circuit = want === 'all' ? 'all' : want ? circuitCode(want) : await liveCircuit();

  const [teams, all] = await Promise.all([loadAllTeams(), getAllSizes()]);
  // Newest season first, so a person on rosters in two seasons shows their current team.
  teams.sort((a, b) => seasonOrder(b.circuit) - seasonOrder(a.circuit));
  const seen = new Set();
  const rows = [];
  for (const team of teams) {
    if (circuit !== 'all' && circuitCode(team.circuit) !== circuit) continue;
    for (const p of activeRoster(team)) {
      const key = sizeKey({ email: p.email, playerId: p.id });
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const rec = lookupSize(all, { email: p.email, playerId: p.id });
      rows.push({
        name: p.name || '', team: team.name || '', division: team.division || '', season: seasonName(team.circuit),
        gender: p.gender || '', email: p.email || '', playerId: p.id, isSub: !!p.isSub,
        size: rec?.size || null, cut: rec?.cut || null, by: rec?.by || null, updatedAt: rec?.updatedAt || null,
      });
    }
  }
  rows.sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name));

  if (url.searchParams.get('format') === 'csv') {
    const head = ['Name', 'Team', 'Division', 'Season', 'Gender', 'Sub', 'Size', 'Cut', 'Email'];
    const lines = [head.join(',')].concat(rows.map(r => [r.name, r.team, r.division, r.season, r.gender, r.isSub ? 'yes' : '', r.size || '', r.size ? (r.cut || 'unisex') : '', r.email].map(csvCell).join(',')));
    return new Response(lines.join('\r\n'), { status: 200, headers: {
      'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="dink-society-shirt-sizes-${circuit}.csv"`,
    } });
  }

  return json({ ok: true, circuit, sizes: SIZES, cuts: CUTS, tally: tally(rows), rows });
};

export const config = { path: '/.netlify/functions/admin-shirt-sizes' };
