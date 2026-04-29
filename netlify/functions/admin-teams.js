// netlify/functions/admin-teams.js
// Returns all teams from the teams Blobs store.
// Admin-only.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

export default async (req) => {
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  try {
    const store = getStore('teams');
    const { blobs } = await store.list({ prefix: 'team/' });

    const teams = await Promise.all(
      blobs.map(async (b) => {
        try {
          return await store.get(b.key, { type: 'json' });
        } catch (e) {
          console.warn(`Failed to read team blob ${b.key}:`, e.message);
          return null;
        }
      })
    );

    const valid = teams.filter(Boolean).sort((a, b) => {
      // Sort by division, then name
      const da = a.division || '';
      const db = b.division || '';
      if (da !== db) return da.localeCompare(db);
      return (a.name || '').localeCompare(b.name || '');
    });

    return new Response(JSON.stringify({ teams: valid }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('admin-teams error:', err);
    return new Response(JSON.stringify({ error: 'Failed to load teams' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
