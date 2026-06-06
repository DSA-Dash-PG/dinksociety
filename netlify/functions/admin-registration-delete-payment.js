// netlify/functions/admin-registration-delete-payment.js
// 'delete-payment' action, split from admin-registration-update.js.
// Removes a manual payment entry from a registration.
//
// POST { id, paymentId }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration, migratePayments, recalcPayments } from './lib/registrations.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body) {
  const regStore = getStore('registrations');

  const { id, paymentId } = body;
  if (!id || !paymentId) return json({ error: 'id and paymentId required' }, 400);

  const found = await findRegistration(regStore, id);
  if (!found) return json({ error: 'Registration not found' }, 404);
  const { reg, foundKey } = found;

  migratePayments(reg);
  const before = reg.manualPayments.length;
  reg.manualPayments = reg.manualPayments.filter(p => p.id !== paymentId);
  if (reg.manualPayments.length === before) return json({ error: 'Payment not found' }, 404);

  recalcPayments(reg);
  await regStore.set(foundKey, JSON.stringify(reg));
  return json({ ok: true, registration: reg });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const body = await req.json();
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-delete-payment' };
