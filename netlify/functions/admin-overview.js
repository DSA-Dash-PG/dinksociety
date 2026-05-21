// netlify/functions/admin-overview.js
// Returns aggregate stats for the admin dashboard Overview tab.
//
// Divisions are read live from the 'seasons' blob store (Admin → Seasons)
// so the Overview always matches the configured season. Any division code
// that turns up in registrations but is NOT in the season config is still
// shown (flagged `unconfigured`) so data drift is visible rather than hidden.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

// Live division list from the seasons store: [{ id, label, capacity }]
// De-duplicated by id, across all non-archived seasons.
async function getSeasonDivisions() {
  try {
    const store = getStore('seasons');
    const { blobs } = await store.list();
    const divisions = [];
    const seen = new Set();
    for (const blob of blobs) {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      let season;
      try {
        season = JSON.parse(raw);
      } catch {
        continue;
      }
      if (season.status === 'archived') continue;
      for (const d of season.divisions || []) {
        if (!d || !d.id || seen.has(d.id)) continue;
        seen.add(d.id);
        divisions.push({
          id: d.id,
          label: d.name || d.id,
          capacity: Number(d.capacity) || 6,
        });
      }
    }
    return divisions;
  } catch (err) {
    console.error('admin-overview: failed to load season divisions:', err);
    return [];
  }
}

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  try {
    const regStore = getStore('registrations');
    const momentsStore = getStore('moments');

    // List all confirmed + pending registrations
    const { blobs: confirmedBlobs } = await regStore.list({ prefix: 'confirmed/' });
    const { blobs: pendingBlobs } = await regStore.list({ prefix: 'pending/' });

    const confirmed = (await Promise.all(
      confirmedBlobs.map(b => regStore.get(b.key, { type: 'json' }))
    )).filter(Boolean);
    const pending = (await Promise.all(
      pendingBlobs.map(b => regStore.get(b.key, { type: 'json' }))
    )).filter(Boolean);

    const allRegs = [...confirmed, ...pending];

    // Live divisions from Admin → Seasons
    const seasonDivisions = await getSeasonDivisions();

    // Stats
    const teams = confirmed.filter(r => r?.path === 'team').length;
    const agents = confirmed.filter(r => r?.path === 'agent').length;

    // Revenue: amountPaid is already in dollars (webhook converts from cents)
    const revenue = confirmed.reduce((sum, r) => sum + (r?.amountPaid || 0), 0);

    // Count photos
    const { blobs: photoBlobs } = await momentsStore.list({ prefix: 'meta/' });
    const photos = photoBlobs.length;

    // Division fill — seed from the configured divisions, then fold in any
    // division codes that appear in confirmed team registrations but are not
    // configured (so drift surfaces instead of silently disappearing).
    const fillByDiv = {};
    const order = [];
    for (const d of seasonDivisions) {
      fillByDiv[d.id] = { division: d.id, label: d.label, filled: 0, capacity: d.capacity };
      order.push(d.id);
    }
    for (const r of confirmed) {
      if (r?.path !== 'team' || !r.division) continue;
      if (!fillByDiv[r.division]) {
        fillByDiv[r.division] = {
          division: r.division,
          label: r.divisionLabel || r.division,
          filled: 0,
          capacity: 6,
          unconfigured: true,
        };
        order.push(r.division);
      }
      fillByDiv[r.division].filled++;
    }
    const divisionFill = order.map(id => fillByDiv[id]);

    // Total team capacity across configured divisions (fall back to whatever
    // divisions actually appear if no season is configured yet).
    const teamCapacity = seasonDivisions.length
      ? seasonDivisions.reduce((sum, d) => sum + d.capacity, 0)
      : divisionFill.reduce((sum, d) => sum + (d.capacity || 0), 0);

    // Division label lookup for recent activity
    const labelById = {};
    for (const d of divisionFill) labelById[d.division] = d.label;

    // Recent 10 registrations sorted desc
    const recent = allRegs
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map(r => ({
        id: r.id,
        path: r.path,
        division: r.division,
        divisionLabel: r.divisionLabel || labelById[r.division] || r.division,
        status: r.status || 'pending',
        createdAt: r.createdAt,
        displayName: r.path === 'team'
          ? `${r.team?.name || 'Team'} (${r.team?.players?.[0]?.name || '—'})`
          : (r.agent?.name || '—'),
      }));

    return new Response(JSON.stringify({
      stats: {
        teams,
        agents,
        teamCapacity,
        revenue: Math.round(revenue),
        photos,
      },
      divisionFill,
      recent,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('admin-overview error:', err);
    return new Response(JSON.stringify({ error: 'Failed to load overview' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/admin-overview' };
