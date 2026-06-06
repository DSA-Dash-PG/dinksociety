// netlify/functions/admin-registration-set-price.js
// 'set-price' action, split from admin-registration-update.js.
// Overrides totalPrice and recalculates the balance.
//
// POST { id, price }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration, migratePayments, recalcPayments } from './lib/registrations.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body) {
  const regStore = getStore('registrations');

  const { id, price } = body;
  if (!id) return json({ error: 'id required' }, 400);
  const price_ = parseFloat(price);
  if (isNaN(price_) || price_ < 0) return json({ error: 'Invalid price' }, 400);

  const found = await findRegistration(regStore, id);
  if (!found) return json({ error: 'Registration not found' }, 404);
  const { reg, foundKey } = found;

  reg.totalPrice = price_;
  migratePayments(reg);
  recalcPayments(reg);
  reg.updatedAt = new Date().toISOString();
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

export const config = { path: '/.netlify/functions/admin-registration-set-price' };
