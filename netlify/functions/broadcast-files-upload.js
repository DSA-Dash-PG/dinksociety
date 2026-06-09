// netlify/functions/broadcast-files-upload.js
// Accepts multipart/form-data POST with a single `file`.
// Stores the binary in the 'broadcast-files' blob store under "file/<id>" and
// metadata under "meta/<id>.json". Returns { id, filename, size, contentType }.
// The id is later attached to a broadcast; the file is emailed as a real
// attachment (and offered as a download link in the portal).
//
// Admin-only — requires magic-link auth.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';

const MAX_BYTES = 15 * 1024 * 1024; // 15 MB — Resend caps total message size ~40MB
// Friendly, common attachment types for a league bulletin.
const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv',
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  try {
    const formData = await req.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400);
    if (!ALLOWED_TYPES.has(file.type)) {
      return json({ error: 'Unsupported file type. Allowed: images, PDF, Word, Excel, CSV, text.' }, 400);
    }
    if (file.size > MAX_BYTES) return json({ error: 'File exceeds 15MB limit' }, 400);

    const store = getStore('broadcast-files');
    const id = cryptoId();
    const filename = (file.name || 'attachment').toString().slice(0, 180).replace(/[\r\n"]/g, '');

    const arrayBuffer = await file.arrayBuffer();
    await store.set(`file/${id}`, arrayBuffer, { metadata: { contentType: file.type, filename } });

    const meta = { id, filename, contentType: file.type, size: file.size, uploadedAt: new Date().toISOString() };
    await store.setJSON(`meta/${id}.json`, meta);

    return json({ ok: true, ...meta });
  } catch (err) {
    console.error('broadcast-files-upload error:', err);
    return json({ error: 'Upload failed', detail: err.message }, 500);
  }
};

function cryptoId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export const config = { path: '/.netlify/functions/broadcast-files-upload' };
