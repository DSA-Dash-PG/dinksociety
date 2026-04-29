// netlify/functions/moments-upload.js
// Accepts a multipart/form-data POST with: file, circuit, week, caption
// Stores the image binary in the 'moments' Netlify Blobs store under "img/<id>"
// Stores metadata JSON under "meta/<id>.json"
//
// Client-side compression handles large files (30MB+) before they hit this function.
// The 6MB limit here matches the real Lambda/Netlify payload ceiling.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB — real Lambda payload ceiling
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export default async (req, context) => {
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers,
    });
  }

  // Admin-only
  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const circuit = (formData.get('circuit') || 'I').toString().toUpperCase().trim();
    const week = parseInt(formData.get('week'), 10);
    const caption = (formData.get('caption') || '').toString().slice(0, 200);

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400, headers });
    }
    if (!/^[IVX]+$/.test(circuit)) {
      return new Response(JSON.stringify({ error: 'Invalid circuit (must be a Roman numeral)' }), { status: 400, headers });
    }
    if (!Number.isInteger(week) || week < 1 || week > 7) {
      return new Response(JSON.stringify({ error: 'Invalid week (must be 1-7)' }), { status: 400, headers });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return new Response(JSON.stringify({ error: 'Only JPG, PNG, or WebP allowed' }), { status: 400, headers });
    }
    if (file.size > MAX_BYTES) {
      return new Response(JSON.stringify({ error: `File is ${(file.size / 1024 / 1024).toFixed(1)}MB — exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)}MB server limit. The admin panel should auto-compress before upload. Try refreshing the page and re-uploading.` }), { status: 400, headers });
    }

    const id = cryptoId();
    const store = getStore('moments');

    // Store the binary under img/<id>
    const arrayBuffer = await file.arrayBuffer();
    await store.set(`img/${id}`, arrayBuffer, {
      metadata: { contentType: file.type },
    });

    // Store metadata under meta/<id>.json
    const meta = {
      id,
      circuit,
      week,
      caption,
      contentType: file.type,
      uploadedAt: new Date().toISOString(),
    };
    await store.setJSON(`meta/${id}.json`, meta);

    return new Response(JSON.stringify({ ok: true, id, circuit, week }), {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error('moments-upload error:', err);
    return new Response(
      JSON.stringify({ error: 'Upload failed', detail: err.message }),
      { status: 500, headers }
    );
  }
};

function cryptoId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const config = { path: '/.netlify/functions/moments-upload' };
