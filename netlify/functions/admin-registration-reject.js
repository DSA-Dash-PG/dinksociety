// netlify/functions/admin-registration-reject.js
// 'reject' action, split from admin-registration-update.js.
// Marks a registration as rejected.
//
// POST { id, reason }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration } from './lib/registrations.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body, admin) {
  const regStore = getStore('registrations');

  const { id, reason } = body;
  if (!id) return json({ error: 'Registration id required' }, 400);

  const found = await findRegistration(regStore, id);
  if (!found) return json({ error: 'Registration not found' }, 404);

  const { reg, foundKey } = found;
  reg.status = 'rejected';
  reg.rejectedAt = new Date().toISOString();
  reg.rejectedBy = admin.email;
  reg.rejectReason = reason || '';

  // Write to rejected/ prefix
  const rejectedKey = `rejected/${id}.json`;
  await regStore.set(rejectedKey, JSON.stringify(reg));
  if (foundKey !== rejectedKey) {
    try { await regStore.delete(foundKey); } catch { /* ok */ }
  }

  return json({ ok: true, registration: reg });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const body = await req.json();
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-reject' };
