// netlify/functions/public-teams.js
// Public endpoint — returns teams grouped by division for the Teams page.
// GET /.netlify/functions/public-teams?circuit=I[&division=3.0M]

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const url = new URL(req.url);
  const circuit = (url.searchParams.get('circuit') || 'I').trim();
  const divisionFilter = url.searchParams.get('division') || '';

  try {
    const store = getStore('teams');
    const { blobs } = await store.list({ prefix: 'team/' });

    const teams = (await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    )).filter(Boolean);

    // Filter by circuit
    const circuitTeams = teams.filter(t => (t.circuit || 'I') === circuit);

    // Optionally filter by division
    const filtered = divisionFilter
      ? circuitTeams.filter(t => t.division === divisionFilter)
      : circuitTeams;

    // Redact sensitive info (emails, phones)
    const safe = filtered.map(t => ({
      id: t.id,
      name: t.name,
      division: t.division,
      divisionLabel: t.divisionLabel || t.division,
      circuit: t.circuit,
      captainName: t.captainName || (t.roster?.[0]?.name) || null,
      roster: (t.roster || []).map(p => ({
        name: p.name,
        gender: p.gender || null,
        dupr: p.dupr || null,
        isCaptain: p.isCaptain || false,
      })),
    }));

    // Group by division
    const byDivision = {};
    for (const t of safe) {
      const div = t.division || 'unknown';
      if (!byDivision[div]) byDivision[div] = [];
      byDivision[div].push(t);
    }

    return new Response(JSON.stringify({ circuit, divisions: byDivision, teamCount: safe.length }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    console.error('public-teams error:', err);
    return new Response(JSON.stringify({ circuit, divisions: {}, teamCount: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/public-teams' };
