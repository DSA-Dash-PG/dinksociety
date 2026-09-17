// netlify/functions/captain-balance.js
// Returns the team's registration payment summary for the captain portal.
// GET /.netlify/functions/captain-balance
//
// Payment data lives on the registration record (linked from the team via
// team.registrationId), so we resolve and project the relevant fields here.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { paidTotal, balanceOf, leagueDiscount } from './lib/registrations.js';
import { CARD_PAYMENTS_ENABLED, VENMO_HANDLE, venmoProfileUrl } from './lib/payment-terms.js';

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
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

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

  // Balance is fee minus RECORDED payments — never the cached reg.balanceDue,
  // which used to be stamped as (fee − deposit) before the deposit was paid.
  const totalPrice = Number(reg.totalPrice ?? reg.price ?? 0);
  const amountPaid = paidTotal(reg);
  const balanceDue = balanceOf(reg);
  const paymentStatus = balanceDue <= 0 && amountPaid > 0 ? 'paid_in_full' : amountPaid > 0 ? 'partial' : 'unpaid';

  return new Response(JSON.stringify({
    hasRegistration: true,
    totalPrice,
    amountPaid,
    balanceDue,
    paymentStatus,
    discountApplied: Number(reg.discountApplied || 0), // Stripe promo code
    // League discount: an admin lowered this team's fee. totalPrice is already the
    // discounted number; listPrice is what it was, so the card can show both.
    listPrice: leagueDiscount(reg) > 0 ? Number(reg.listPrice) : null,
    leagueDiscount: leagueDiscount(reg),
    // Deposit terms, so the portal can say "deposit of $250 was due at signup".
    paymentType: reg.paymentType || null,
    depositAmount: reg.depositAmount != null ? Number(reg.depositAmount) : null,
    balanceDueDate: reg.balanceDueDate || null,
    // How the balance gets paid. Card (Stripe) is off unless CARD_PAYMENTS_ENABLED=true;
    // otherwise the Billing card points the captain at the league's Venmo.
    cardEnabled: CARD_PAYMENTS_ENABLED,
    venmoHandle: VENMO_HANDLE,
    venmoUrl: venmoProfileUrl(),
    currency: 'usd',
  }), { status: 200, headers });
};

export const config = { path: '/.netlify/functions/captain-balance' };
