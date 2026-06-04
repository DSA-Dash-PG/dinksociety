// netlify/functions/captain-balance.js
// Returns the team's registration payment summary for the captain portal.
// GET /.netlify/functions/captain-balance
//
// Payment data lives on the registration record (linked from the team via
// team.registrationId), so we resolve and project the relevant fields here.

import { getStore } from '@netlify/blobs';
import { requireCaptain, unauthResponse } from './lib/captain-auth.js';

async function findRegistration(regStore, id) {
  const keys = [`confirmed/${id}.json`, `pending/${id}.json`, id];
  for (const key of keys) {
    const raw = await regStore.get(key).catch(() => null);
    if (raw) {
      try { return JSON.parse(raw); } catch { return null; }
    }
  }
  return null;
}

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
  const regId = ctx.team.registrationId;

  if (!regId) {
    return new Response(JSON.stringify({ hasRegistration: false }), { status: 200, headers });
  }

  const regStore = getStore('registrations');
  const reg = await findRegistration(regStore, regId);

  if (!reg) {
    return new Response(JSON.stringify({ hasRegistration: false }), { status: 200, headers });
  }

  const totalPrice = Number(reg.totalPrice ?? reg.price ?? 0);
  const amountPaid = Number(reg.amountPaid ?? 0);
  const balanceDue = Math.max(0, Number(reg.balanceDue ?? (totalPrice - amountPaid)));
  const paymentStatus = reg.paymentStatus
    || (balanceDue <= 0 && amountPaid > 0 ? 'paid_in_full' : amountPaid > 0 ? 'partial' : 'unpaid');

  return new Response(JSON.stringify({
    hasRegistration: true,
    totalPrice,
    amountPaid,
    balanceDue,
    paymentStatus,
    discountApplied: Number(reg.discountApplied || 0),
    currency: 'usd',
  }), { status: 200, headers });
};

export const config = { path: '/.netlify/functions/captain-balance' };
