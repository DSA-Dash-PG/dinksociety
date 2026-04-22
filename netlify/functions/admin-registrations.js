// netlify/functions/admin-registrations.js
// Returns all registrations (confirmed + pending) with full details.
// Admin-only — returns more than the public registration-lookup endpoint.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  try {
    const store = getStore('registrations');

    const { blobs: confirmedBlobs } = await store.list({ prefix: 'confirmed/' });
    const { blobs: pendingBlobs } = await store.list({ prefix: 'pending/' });

    const confirmed = await Promise.all(
      confirmedBlobs.map(b => store.get(b.key, { type: 'json' }))
    );
    const pending = await Promise.all(
      pendingBlobs.map(b => store.get(b.key, { type: 'json' }))
    );

    const all = [...confirmed, ...pending]
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // For admin we include emails + phone (but scrub Stripe internals)
    const projected = all.map(r => ({
      id: r.id,
      circuit: r.circuit,
      division: r.division,
      divisionLabel: r.divisionLabel,
      path: r.path,
      status: r.status || 'pending',
      amountPaid: r.amountPaid,
      createdAt: r.createdAt,
      confirmedAt: r.confirmedAt || null,
      team: r.team ? {
        name: r.team.name,
        captain: r.team.players?.[0]?.name || null,
        players: r.team.players?.map(p => ({
          name: p.name,
          email: p.email,
          phone: p.phone || null,
          captain: p.captain || false,
        })) || [],
      } : null,
      agent: r.agent ? {
        name: r.agent.name,
        email: r.agent.email,
        phone: r.agent.phone || null,
        dupr: r.agent.dupr || null,
        notes: r.agent.notes || null,
      } : null,
    }));

    return new Response(JSON.stringify({ registrations: projected }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('admin-registrations error:', err);
    return new Response(JSON.stringify({ error: 'Failed to load registrations' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/admin-registrations' };
