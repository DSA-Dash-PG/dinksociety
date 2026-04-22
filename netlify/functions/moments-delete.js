// netlify/functions/moments-delete.js
// Deletes both the image binary and the metadata for a moment.
// Admin-gated.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

export default async (req) => {
  if (req.method !== 'DELETE') {
    return new Response('Method not allowed', { status: 405 });
  }

  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id || !/^[a-f0-9]{16}$/.test(id)) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const store = getStore('moments');
    // Delete both keys — ignore missing
    await Promise.all([
      store.delete(`img/${id}`).catch(() => null),
      store.delete(`meta/${id}.json`).catch(() => null),
    ]);

    return new Response(JSON.stringify({ ok: true, id }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('moments-delete error:', err);
    return new Response(JSON.stringify({ error: 'Delete failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/.netlify/functions/moments-delete' };
