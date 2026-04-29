// netlify/functions/site-images-upload.js
// Accepts multipart/form-data POST with: file, slot, label
// Stores image binary in 'site-images' blob store under "img/<id>"
// Stores metadata JSON under "meta/<id>.json"
// Updates the slot registry at "slots.json" so the frontend knows which
// images belong to each page section (hero, divider-1, divider-2, cta).
//
// Admin-only — requires magic-link auth.

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VALID_SLOTS = new Set(['hero', 'divider-1', 'divider-2', 'cta']);
const MAX_PER_SLOT = 8; // max images per slot (hero slideshow limit)

export default async (req, context) => {
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const slot = (formData.get('slot') || '').toString().trim().toLowerCase();
    const label = (formData.get('label') || '').toString().slice(0, 100);

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400, headers });
    }
    if (!VALID_SLOTS.has(slot)) {
      return new Response(JSON.stringify({ error: `Invalid slot. Must be one of: ${[...VALID_SLOTS].join(', ')}` }), { status: 400, headers });
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      return new Response(JSON.stringify({ error: 'Only JPG, PNG, or WebP allowed' }), { status: 400, headers });
    }
    if (file.size > MAX_BYTES) {
      return new Response(JSON.stringify({ error: 'File exceeds 10MB limit' }), { status: 400, headers });
    }

    const store = getStore('site-images');
    const id = cryptoId();

    // Store binary
    const arrayBuffer = await file.arrayBuffer();
    await store.set(`img/${id}`, arrayBuffer, {
      metadata: { contentType: file.type },
    });

    // Store metadata
    const meta = {
      id,
      slot,
      label,
      contentType: file.type,
      size: file.size,
      uploadedAt: new Date().toISOString(),
    };
    await store.setJSON(`meta/${id}.json`, meta);

    // Update slot registry
    let slots = {};
    try {
      slots = await store.get('slots.json', { type: 'json' }) || {};
    } catch { /* first time — empty */ }

    if (!slots[slot]) slots[slot] = [];

    // Enforce max per slot
    if (slots[slot].length >= MAX_PER_SLOT) {
      return new Response(JSON.stringify({
        error: `Slot "${slot}" already has ${MAX_PER_SLOT} images. Remove one first.`
      }), { status: 400, headers });
    }

    slots[slot].push({ id, label, uploadedAt: meta.uploadedAt });
    await store.setJSON('slots.json', slots);

    return new Response(JSON.stringify({ ok: true, id, slot, label }), { status: 200, headers });

  } catch (err) {
    console.error('site-images-upload error:', err);
    return new Response(JSON.stringify({ error: 'Upload failed', detail: err.message }), { status: 500, headers });
  }
};

function cryptoId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const config = { path: '/.netlify/functions/site-images-upload' };
