// netlify/functions/public-registered-teams.js
//
// PUBLIC endpoint — no auth. Returns the APPROVED (confirmed) teams for a
// season, so the registration page can show a live "who's in" list that grows
// as sign-ups get approved. Deliberately exposes only team name + division —
// never captain names, emails, phones, or payment data.
//
// GET /.netlify/functions/public-registered-teams?circuit=II
//   (or ?season=circuit-ii — the code is derived from the season id)
//   → { circuit, count, teams: [ { name, division, divisionLabel, confirmedAt } ] }

import { getStore } from '@netlify/blobs';

// seasonId ("circuit-ii" / "circuit-2") → circuit CODE ("II"). Mirrors
// register.html circuitCodeFromSeasonId so the page and API agree.
function circuitCodeFromSeasonId(seasonId) {
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
  const tail = String(seasonId || '').replace(/^circuit-/i, '').trim();
  if (/^\d+$/.test(tail)) {
    const n = parseInt(tail, 10);
    return (n >= 1 && n <= 10) ? ROMAN[n - 1] : String(n);
  }
  return tail ? tail.toUpperCase() : 'I';
}

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const circuitParam = (url.searchParams.get('circuit') || '').trim();
  const seasonParam = (url.searchParams.get('season') || '').trim();
  const circuit = (circuitParam || circuitCodeFromSeasonId(seasonParam || 'circuit-i')).toUpperCase();

  try {
    const store = getStore('registrations');
    const { blobs } = await store.list({ prefix: 'confirmed/' });
    const regs = await Promise.all(
      blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
    );

    const teams = regs
      .filter(Boolean)
      // Confirmed prefix already implies approved; match the requested circuit.
      .filter(r => String(r.circuit || '').toUpperCase() === circuit)
      .filter(r => r.team && r.team.name)
      .map(r => ({
        name: r.team.name,
        division: r.division || null,
        divisionLabel: r.divisionLabel || r.division || null,
        confirmedAt: r.confirmedAt || r.createdAt || null,
      }))
      // Oldest approvals first — the list reads as a growing lineup.
      .sort((a, b) => new Date(a.confirmedAt || 0) - new Date(b.confirmedAt || 0));

    return new Response(JSON.stringify({ circuit, count: teams.length, teams }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Short cache — the list changes only when an admin approves a team.
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    console.error('public-registered-teams error:', err);
    return new Response(JSON.stringify({ circuit, count: 0, teams: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/public-registered-teams' };
