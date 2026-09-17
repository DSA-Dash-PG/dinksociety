// tests/registration-discounts.test.js
// Two kinds of discount, stored differently, and neither may come back as a
// balance the team doesn't owe:
//   league discount — admin lowers totalPrice; listPrice remembers the original
//   Stripe promo    — totalPrice stays at list; discountApplied holds the cut

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { owedTotal, leagueDiscount, balanceOf, paidTotal, recalcPayments } from '../netlify/functions/lib/registrations.js';

test('league discount: $700 team lowered to $600 owes $600', () => {
  const reg = { totalPrice: 600, listPrice: 700, priceNote: 'returning team', manualPayments: [], stripeAmountPaid: 0 };
  assert.equal(owedTotal(reg), 600);
  assert.equal(leagueDiscount(reg), 100);
  assert.equal(balanceOf(reg), 600);
  reg.manualPayments.push({ amount: 250 });
  assert.equal(balanceOf(reg), 350);
  reg.manualPayments.push({ amount: 350 });
  assert.equal(balanceOf(reg), 0);
  recalcPayments(reg);
  assert.equal(reg.paymentStatus, 'paid'); assert.equal(reg.balanceDue, 0); assert.equal(reg.amountPaid, 600);
});

test('no discount: nothing to show, full fee owed', () => {
  const reg = { totalPrice: 700, manualPayments: [], stripeAmountPaid: 0 };
  assert.equal(leagueDiscount(reg), 0);
  assert.equal(balanceOf(reg), 700);
  assert.equal(leagueDiscount({ totalPrice: 750, listPrice: 700 }), 0); // a raised fee is not a discount
});

test('Stripe promo: 50% off paid in full leaves no phantom balance', () => {
  const reg = { totalPrice: 700, discountApplied: 350, amountPaid: 350 };
  assert.equal(paidTotal(reg), 350);
  assert.equal(owedTotal(reg), 350);
  assert.equal(balanceOf(reg), 0);
});

test('Stripe promo on the balance payment only', () => {
  // $250 deposit, then the $450 balance paid with a $100-off code → $350 charged
  const reg = { totalPrice: 700, discountApplied: 100, amountPaid: 600 };
  assert.equal(balanceOf(reg), 0);
});
