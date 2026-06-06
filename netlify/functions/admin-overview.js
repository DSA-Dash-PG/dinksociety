// netlify/functions/admin-overview.js
// Returns aggregate stats for the admin dashboard Overview tab.
//
// Divisions are read live from the 'seasons' blob store (Admin → Seasons)
// so the Overview always matches the configured season. Any division code
// that turns up in registrations but is NOT in the season config is still
// shown (flagged `unconfigured`) so data drift is visible rather than hidden.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';

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
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  try {
    const regStore = getStore('registrations');
    const momentsStore = getStore('moments');
    const teamsStore = getStore('teams');

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

    // Total fees owed and balance still outstanding across confirmed registrations.
    // Subtract any discount applied (e.g. a Stripe promo code) so the total
    // reflects the actual obligation, not the pre-discount list price. Without
    // this, the discount amount shows up as an unexplained gap between the total
    // and (collected + balance due).
    const totalFees = confirmed
      .filter(r => r?.path === 'team')
      .reduce((sum, r) => sum + Math.max(0, (r?.totalPrice || r?.price || 0) - (r?.discountApplied || 0)), 0);
    const balanceDue = confirmed.reduce((sum, r) => {
      if (r?.balanceDue != null) return sum + (r.balanceDue || 0);
      return sum + Math.max(0, (r?.totalPrice || r?.price || 0) - (r?.amountPaid || 0));
    }, 0);

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

    // Current captain lookup, keyed by the registration the team was created from.
    // Teams are the source of truth for captaincy — the registration blob only
    // holds the roster as it was at sign-up and is never updated when an admin
    // reassigns the captain on the Teams page. Without this, Recent Activity
    // shows whoever registered the team, not the current captain.
    const captainByRegId = {};
    try {
      const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' });
      const teamRecords = (await Promise.all(
        teamBlobs.map(b => teamsStore.get(b.key, { type: 'json' }).catch(() => null))
      )).filter(Boolean);
      for (const t of teamRecords) {
        if (!t.registrationId) continue;
        const flagged = (t.roster || []).find(p => p.isCaptain);
        const captainName = flagged?.name || t.captainName || t.captain || null;
        if (captainName) captainByRegId[t.registrationId] = captainName;
      }
    } catch (err) {
      console.error('admin-overview: failed to load teams for captain lookup:', err);
    }

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
          ? `${r.team?.name || 'Team'} (${captainByRegId[r.id] || r.team?.players?.[0]?.name || '—'})`
          : (r.agent?.name || '—'),
      }));

    return new Response(JSON.stringify({
      stats: {
        teams,
        agents,
        teamCapacity,
        revenue: Math.round(revenue),
        totalFees: Math.round(totalFees),
        balanceDue: Math.round(balanceDue),
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
