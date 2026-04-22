// netlify/functions/moments-list.js
// Lists all moments from the 'moments' Netlify Blobs store.
// Returns: { moments: [{ id, week, caption, url, uploadedAt }, ...] }

import { getStore } from '@netlify/blobs';

export default async (req, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  };

  try {
    const store = getStore('moments');

    // Metadata is stored under keys like "meta/<id>.json"
    const { blobs } = await store.list({ prefix: 'meta/' });

    const moments = await Promise.all(
      blobs.map(async (b) => {
        const json = await store.get(b.key, { type: 'json' });
        if (!json) return null;
        return {
          id: json.id,
          circuit: json.circuit || 'I', // default for legacy records
          week: json.week,
          caption: json.caption || '',
          url: `/.netlify/functions/moments-image?id=${encodeURIComponent(json.id)}`,
          uploadedAt: json.uploadedAt,
        };
      })
    );

    const filtered = moments.filter(Boolean);

    return new Response(JSON.stringify({ moments: filtered }), {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error('moments-list error:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to list moments', detail: err.message }),
      { status: 500, headers }
    );
  }
};

export const config = { path: '/.netlify/functions/moments-list' };
