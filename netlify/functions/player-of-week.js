// netlify/functions/player-of-week.js
// GET  → return current Player of the Week data (public, no auth)
// POST → save Player of the Week data (admin-only)

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default async (req) => {
  const store = getStore({ name: 'config', consistency: 'strong' });

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' } });
  }

  // GET — public
  if (req.method === 'GET') {
    try {
      const raw = await store.get('player-of-week');
      return json(raw ? JSON.parse(raw) : { empty: true });
    } catch (e) {
      console.error('player-of-week GET error:', e);
      return json({ empty: true });
    }
  }

  // POST — admin only
  if (req.method === 'POST') {
    const authed = await requireAdmin(req);
    if (!authed) return unauthResponse();

    try {
      const body = await req.json();
      const data = {
        male:      body.male      || null,
        female:    body.female    || null,
        week:      body.week      || null,
        updatedAt: new Date().toISOString(),
      };
      await store.set('player-of-week', JSON.stringify(data));
      return json({ ok: true, data });
    } catch (e) {
      console.error('player-of-week POST error:', e);
      return json({ error: 'Failed to save' }, 500);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
};

export const config = { path: '/api/player-of-week' };
