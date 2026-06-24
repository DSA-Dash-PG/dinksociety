// netlify/functions/admin-badge-logo.js
// Upload a custom logo for a badge. multipart/form-data POST with: file, kind.
// Stores the image in the existing 'site-images' store under "img/<id>" so the
// public site-images-serve endpoint streams it, then records the logo id on the
// badge's config override. Admin-only.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { setBadgeLogo } from './lib/badges-config.js';

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = new Set(['image/png', 'image/webp', 'image/svg+xml', 'image/jpeg']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function cryptoId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const kind = (formData.get('kind') || '').toString().trim();

    if (!kind) return json({ error: 'kind required' }, 400);
    if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400);
    if (!ALLOWED_TYPES.has(file.type)) return json({ error: 'Only PNG, WebP, SVG or JPG allowed' }, 400);
    if (file.size > MAX_BYTES) return json({ error: 'File exceeds 5MB limit' }, 400);

    const store = getStore('site-images');
    const id = cryptoId();
    const arrayBuffer = await file.arrayBuffer();
    await store.set(`img/${id}`, arrayBuffer, { metadata: { contentType: file.type } });
    await store.setJSON(`meta/${id}.json`, {
      id, kind, contentType: file.type, size: file.size, uploadedAt: new Date().toISOString(), purpose: 'badge-logo',
    });

    const config = await setBadgeLogo(kind, id, admin.email);
    return json({ ok: true, id, kind, url: `/.netlify/functions/site-images-serve?id=${id}`, config });
  } catch (err) {
    console.error('admin-badge-logo error:', err);
    return json({ error: 'Upload failed', detail: err.message }, 500);
  }
};

export const config = { path: '/.netlify/functions/admin-badge-logo' };
