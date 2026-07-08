// netlify/functions/drop-photo-upload.js
// Upload a photo for "The Drop". Admin only.
//
// POST multipart/form-data with: file, circuit (optional), week (optional)
//   Auth: any admin session.
//
// Each upload gets a fresh immutable id and is stored in the 'drop-photos' blob
// store under "img/<id>". The endpoint does NOT touch the Drop record — the
// admin composer holds the returned id and persists it (with a caption) on the
// next save-draft / publish. That keeps upload decoupled and re-uploads cheap;
// unreferenced images are simply never rendered (same model as site-images).
//
// Returns: { ok, id, url, contentType }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';

const MAX_BYTES = 6 * 1024 * 1024; // 6 MB — Lambda payload ceiling
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function rand() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  } catch { /* noop */ }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export default async (req) => {
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  try {
    const admin = await verifyAdminSession(req);
    if (!admin.valid) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers });
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const circuit = circuitCode((formData.get('circuit') || 'I').toString().trim() || 'I');
    const weekRaw = (formData.get('week') || '').toString().trim();
    const week = /^\d{1,2}$/.test(weekRaw) ? weekRaw : '0';

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400, headers });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return new Response(JSON.stringify({ error: 'Only JPG, PNG, or WebP allowed' }), { status: 400, headers });
    }
    if (file.size > MAX_BYTES) {
      return new Response(JSON.stringify({
        error: `File is ${(file.size / 1024 / 1024).toFixed(1)}MB — exceeds the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit.`,
      }), { status: 400, headers });
    }

    // Immutable id, scoped by circuit + week for easy housekeeping. Kept within
    // the serve endpoint's VALID_ID charset (a-zA-Z0-9_-, <=80 chars).
    const id = `d_${circuit}_w${week}_${rand()}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

    const store = getStore('drop-photos');
    const arrayBuffer = await file.arrayBuffer();
    await store.set(`img/${id}`, arrayBuffer, { metadata: { contentType: file.type } });

    return new Response(JSON.stringify({
      ok: true,
      id,
      url: `/.netlify/functions/drop-photo-serve?id=${encodeURIComponent(id)}`,
      contentType: file.type,
    }), { status: 200, headers });
  } catch (err) {
    console.error('drop-photo-upload error:', err);
    return new Response(JSON.stringify({ error: 'Upload failed', detail: err.message }), { status: 500, headers });
  }
};

export const config = { path: '/.netlify/functions/drop-photo-upload' };
