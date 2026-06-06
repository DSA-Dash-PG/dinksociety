// netlify/functions/admin-registration-edit-payment.js
// 'edit-payment' action, split from admin-registration-update.js.
// Updates an existing manual payment entry.
//
// POST { id, paymentId, amount, method, note }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration, migratePayments, recalcPayments } from './lib/registrations.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body, admin) {
  const regStore = getStore('registrations');

  const { id, paymentId, amount, method, note } = body;
  if (!id || !paymentId) return json({ error: 'id and paymentId required' }, 400);
  const VALID_METHODS = ['zelle', 'venmo', 'cash', 'other'];
  const payMethod = VALID_METHODS.includes(method) ? method : 'other';
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return json({ error: 'Invalid amount' }, 400);

  const found = await findRegistration(regStore, id);
  if (!found) return json({ error: 'Registration not found' }, 404);
  const { reg, foundKey } = found;

  migratePayments(reg);
  const idx = reg.manualPayments.findIndex(p => p.id === paymentId);
  if (idx === -1) return json({ error: 'Payment not found' }, 404);

  reg.manualPayments[idx] = {
    ...reg.manualPayments[idx],
    amount: amt,
    method: payMethod,
    note: note || '',
    updatedAt: new Date().toISOString(),
    updatedBy: admin.email,
  };
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

export const config = { path: '/.netlify/functions/admin-registration-edit-payment' };
