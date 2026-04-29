// netlify/functions/site-images-list.js
// GET  — Public: returns the slot registry so the frontend knows which images to show
// POST — Admin-only: delete an image by id + slot, or reorder images within a slot

import { getStore } from '@netlify/blobs';

export default async (req, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  // ── GET: return slot registry (public, no auth) ──
  if (req.method === 'GET') {
    try {
      const store = getStore('site-images');
      let slots = {};
      try {
        const raw = await store.get('slots.json', { type: 'json' });
        if (raw) slots = raw;
      } catch (e) {
        // Store or key doesn't exist yet — return empty
        console.log('site-images slots.json not found (expected on first run):', e.message);
      }

      // Build public-friendly response with image URLs
      const result = {};
      for (const [slot, images] of Object.entries(slots)) {
        if (!Array.isArray(images)) continue;
        result[slot] = images.map(img => ({
          id: img.id,
          label: img.label || '',
          url: `/.netlify/functions/site-images-serve?id=${img.id}`,
        }));
      }

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          ...headers,
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        },
      });
    } catch (err) {
      console.error('site-images-list GET error:', err);
      // Return empty object instead of error so the frontend degrades gracefully
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: {
          ...headers,
          'Cache-Control': 'public, max-age=30',
        },
      });
    }
  }

  // ── POST: admin actions (delete, reorder) ──
  if (req.method === 'POST') {
    // Lazy-import admin auth only when needed (avoids auth side-effects on public GET)
    const { requireAdmin, unauthResponse } = await import('./lib/admin-auth.js');
    const admin = await requireAdmin(req);
    if (!admin) return unauthResponse();

    try {
      const store = getStore('site-images');
      const body = await req.json();
      const { action } = body;

      // DELETE an image
      if (action === 'delete') {
        const { id, slot } = body;
        if (!id || !slot) {
          return new Response(JSON.stringify({ error: 'Missing id or slot' }), { status: 400, headers });
        }

        let slots = {};
        try {
          const raw = await store.get('slots.json', { type: 'json' });
          if (raw) slots = raw;
        } catch { /* empty */ }

        if (slots[slot]) {
          slots[slot] = slots[slot].filter(img => img.id !== id);
        }
        await store.setJSON('slots.json', slots);

        try { await store.delete(`img/${id}`); } catch { /* ok */ }
        try { await store.delete(`meta/${id}.json`); } catch { /* ok */ }

        return new Response(JSON.stringify({ ok: true, deleted: id }), { status: 200, headers });
      }

      // REORDER images within a slot
      if (action === 'reorder') {
        const { slot, ids } = body;
        if (!slot || !Array.isArray(ids)) {
          return new Response(JSON.stringify({ error: 'Missing slot or ids array' }), { status: 400, headers });
        }

        let slots = {};
        try {
          const raw = await store.get('slots.json', { type: 'json' });
          if (raw) slots = raw;
        } catch { /* empty */ }

        if (!slots[slot]) {
          return new Response(JSON.stringify({ error: 'Slot not found' }), { status: 404, headers });
        }

        const byId = {};
        for (const img of slots[slot]) byId[img.id] = img;

        const reordered = [];
        for (const id of ids) {
          if (byId[id]) reordered.push(byId[id]);
        }
        for (const img of slots[slot]) {
          if (!ids.includes(img.id)) reordered.push(img);
        }

        slots[slot] = reordered;
        await store.setJSON('slots.json', slots);

        return new Response(JSON.stringify({ ok: true, slot, order: reordered.map(i => i.id) }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400, headers });

    } catch (err) {
      console.error('site-images-list POST error:', err);
      return new Response(JSON.stringify({ error: 'Action failed', detail: err.message }), { status: 500, headers });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
};

export const config = { path: '/.netlify/functions/site-images-list' };
