// netlify/functions/admin-registration-reinstate.js
// 'reinstate' action, split from admin-registration-update.js.
// Moves a rejected registration back to confirmed.
//
// POST { id }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration } from './lib/registrations.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body) {
  const regStore = getStore('registrations');

  const { id } = body;
  if (!id) return json({ error: 'Registration id required' }, 400);

  const found = await findRegistration(regStore, id);
  if (!found) return json({ error: 'Registration not found' }, 404);

  const { reg, foundKey } = found;
  if (reg.status !== 'rejected') {
    return json({ error: 'Only rejected registrations can be reinstated' }, 400);
  }
  reg.status = 'confirmed';
  delete reg.rejectedAt;
  delete reg.rejectReason;

  const confirmedKey = `confirmed/${id}.json`;
  await regStore.set(confirmedKey, JSON.stringify(reg));
  if (foundKey !== confirmedKey) {
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

export const config = { path: '/.netlify/functions/admin-registration-reinstate' };
