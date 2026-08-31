// =============================================================
// GET /api/public-seasons
//
// Returns seasons for the public registration / league landing page. No auth.
//
// Response: { seasons: [{ id, name, label, status, registration, image, ... }] }
// Returns every non-archived, non-test season (so the landing page can still
// show a featured/upcoming season while its registration is closed — the page
// decides open-vs-closed from each season's `registration` flag). Strips Stripe
// IDs and internal fields.
// =============================================================

import { getStore } from '@netlify/blobs';
import { resolveDepositTerms, VENMO_HANDLE } from './lib/payment-terms.js';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const store = getStore('seasons');
    const { blobs } = await store.list();
    const seasons = [];

    for (const blob of blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      try {
        const season = JSON.parse(raw);
        // Never surface test/demo or archived seasons publicly.
        if (season.isTest === true) continue;
        if (season.status === 'archived') continue;

        // Deposit / balance-due terms so the registration page can show the
        // real amount due today (and the Venmo handle to send it to).
        const terms = await resolveDepositTerms(season);

        seasons.push({
          id: season.id,
          name: season.name,
          label: season.label,
          status: season.status,
          registration: season.registration,
          depositAmount: terms.depositAmount,
          balanceDueDate: terms.balanceDueDate,
          venmoHandle: VENMO_HANDLE,
          image: season.image || null,
          tagline: season.tagline || null,
          startDate: season.startDate,
          weeks: season.weeks || 8,
          matchTime: season.matchTime || '7:00–9:00 PM',
          roundsPerMatch: season.roundsPerMatch || 2,
          gamesPerRound: season.gamesPerRound || 6,
          maxRosterSize: season.maxRosterSize || 10,
          divisions: season.divisions.map((d) => ({
            id: d.id,
            name: d.name,
            capacity: d.capacity,
            teamPrice: d.teamPrice,
            agentPrice: d.agentPrice,
          })),
        });
      } catch {}
    }

    return new Response(JSON.stringify({ seasons }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (err) {
    console.error('public-seasons error:', err);
    return new Response(JSON.stringify({ seasons: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
