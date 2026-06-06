// netlify/functions/lib/registrations.js
// Shared helpers for the admin-registration-* functions.
// Extracted verbatim from admin-registration-update.js when that endpoint
// was split into one file per action.

/**
 * Standard JSON response helper used by all registration actions.
 */
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Ensure reg.manualPayments is an array, migrating the legacy single-object
 * manualPayment field if present.
 */
export function migratePayments(reg) {
  if (!Array.isArray(reg.manualPayments)) {
    if (reg.manualPayment) {
      // Migrate old single-object → array entry
      reg.manualPayments = [{
        id: 'mp_legacy',
        amount: reg.amountPaid || 0,
        method: reg.manualPayment.method || 'other',
        note: reg.manualPayment.note || '',
        paidAt: reg.manualPayment.paidAt || new Date().toISOString(),
        paidBy: reg.manualPayment.paidBy || '',
      }];
      delete reg.manualPayment;
      reg.stripeAmountPaid = reg.stripeAmountPaid ?? 0;
    } else {
      reg.manualPayments = [];
      // First touch — treat any existing amountPaid as a Stripe payment
      if (reg.stripeAmountPaid === undefined) {
        reg.stripeAmountPaid = reg.amountPaid || 0;
      }
    }
  }
  if (reg.stripeAmountPaid === undefined) reg.stripeAmountPaid = 0;
}

/**
 * Recalculate amountPaid, balanceDue, and paymentStatus from source data.
 */
export function recalcPayments(reg) {
  const stripeAmt = reg.stripeAmountPaid || 0;
  const manualTotal = (reg.manualPayments || []).reduce((s, p) => s + (p.amount || 0), 0);
  reg.amountPaid = stripeAmt + manualTotal;
  reg.balanceDue = Math.max(0, (reg.totalPrice || 0) - reg.amountPaid);
  const total = reg.totalPrice || 0;
  reg.paymentStatus = total > 0 && reg.amountPaid >= total ? 'paid'
    : reg.amountPaid > 0 ? 'partial' : 'unpaid';
}

/**
 * Find a registration by ID across all prefixes (pending/, confirmed/, rejected/, bare).
 * Returns { reg, foundKey } or null.
 */
export async function findRegistration(regStore, id) {
  const prefixes = [`pending/${id}.json`, `confirmed/${id}.json`, `rejected/${id}.json`, id];
  for (const key of prefixes) {
    try {
      const raw = await regStore.get(key);
      if (raw) return { reg: JSON.parse(raw), foundKey: key };
    } catch { /* not found, try next */ }
  }
  return null;
}
