// netlify/functions/public-registered-teams.js
//
// PUBLIC endpoint — no auth. Returns the teams signed up for a season, so the
// registration page can show a live line-up that grows as sign-ups land.
// Deliberately exposes only team name + division — never captain names, emails,
// phones, or payment data.
//
// Confirmed teams are the headline. Pending ones are included too, flagged, so a
// captain who just registered sees their own name straight away instead of
// wondering whether it worked — the page shows those as "holding a spot" until
// payment is confirmed.
//
// GET /.netlify/functions/public-registered-teams?circuit=II
//   (or ?season=circuit-ii — the code is derived from the season id)
//   → { circuit, count, pendingCount, teams: [ { name, division, divisionLabel, status, confirmedAt } ] }

import { getStore } from '@netlify/blobs';
import { circuitCode } from './lib/circuit.js';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const circuitParam = (url.searchParams.get('circuit') || '').trim();
  const seasonParam = (url.searchParams.get('season') || '').trim();
  const circuit = circuitCode(circuitParam || seasonParam || 'circuit-i');

  try {
    const store = getStore('registrations');
    const [confirmed, pending] = await Promise.all([
      store.list({ prefix: 'confirmed/' }).catch(() => ({ blobs: [] })),
      store.list({ prefix: 'pending/' }).catch(() => ({ blobs: [] })),
    ]);
    const load = async (blobs, status) => {
      const regs = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
      return regs.filter(Boolean).map(r => ({ r, status }));
    };
    const rows = [
      ...await load(confirmed.blobs || [], 'confirmed'),
      ...await load(pending.blobs || [], 'pending'),
    ];

    const seen = new Set();
    const teams = rows
      .filter(({ r }) => circuitCode(r.circuit) === circuit)
      .filter(({ r }) => r.team && r.team.name)
      // A registration can briefly exist under both prefixes mid-confirm; the
      // confirmed copy is loaded first, so the pending twin is dropped here.
      .filter(({ r }) => { const k = r.id || r.team.name; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(({ r, status }) => ({
        name: r.team.name,
        division: r.division || null,
        divisionLabel: r.divisionLabel || r.division || null,
        status,
        confirmedAt: r.confirmedAt || r.createdAt || null,
      }))
      // Confirmed teams lead; within each group, oldest first so the list reads
      // as a growing line-up rather than reshuffling on every visit.
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'confirmed' ? -1 : 1)
        || new Date(a.confirmedAt || 0) - new Date(b.confirmedAt || 0));

    const count = teams.filter(t => t.status === 'confirmed').length;

    return new Response(JSON.stringify({ circuit, count, pendingCount: teams.length - count, teams }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Short cache — the list changes only when an admin approves a team.
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    console.error('public-registered-teams error:', err);
    return new Response(JSON.stringify({ circuit, count: 0, pendingCount: 0, teams: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/public-registered-teams' };
