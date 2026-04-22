// netlify/functions/admin-overview.js
// Returns aggregate stats for the admin dashboard Overview tab.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

const DIVISION_LABELS = {
  '3.0M': '3.0 Mixed',
  '3.5M': '3.5 Mixed',
  '3.5W': "3.5 Women's",
};

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  try {
    const regStore = getStore('registrations');
    const momentsStore = getStore('moments');

    // List all confirmed registrations
    const { blobs: confirmedBlobs } = await regStore.list({ prefix: 'confirmed/' });
    const { blobs: pendingBlobs } = await regStore.list({ prefix: 'pending/' });

    const confirmed = await Promise.all(
      confirmedBlobs.map(b => regStore.get(b.key, { type: 'json' }))
    );
    const pending = await Promise.all(
      pendingBlobs.map(b => regStore.get(b.key, { type: 'json' }))
    );

    const allRegs = [...confirmed, ...pending].filter(Boolean);

    // Stats
    const teams = confirmed.filter(r => r?.path === 'team').length;
    const agents = confirmed.filter(r => r?.path === 'agent').length;
    const revenue = confirmed.reduce((sum, r) => sum + ((r?.amountPaid || 0) / 100), 0);

    // Count photos
    const { blobs: photoBlobs } = await momentsStore.list({ prefix: 'meta/' });
    const photos = photoBlobs.length;

    // Division fill — only count confirmed teams
    const fillByDiv = {};
    for (const key of Object.keys(DIVISION_LABELS)) {
      fillByDiv[key] = { division: key, label: DIVISION_LABELS[key], filled: 0, capacity: 6 };
    }
    for (const r of confirmed) {
      if (r?.path === 'team' && fillByDiv[r.division]) {
        fillByDiv[r.division].filled++;
      }
    }
    const divisionFill = Object.values(fillByDiv).filter(d => d.filled > 0 || d.division !== '3.5W');

    // Recent 10 registrations sorted desc
    const recent = allRegs
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map(r => ({
        id: r.id,
        path: r.path,
        division: r.division,
        divisionLabel: r.divisionLabel || DIVISION_LABELS[r.division],
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
        teamCapacity: 6 * Object.keys(DIVISION_LABELS).filter(k => k !== '3.5W').length, // 12 for now
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
