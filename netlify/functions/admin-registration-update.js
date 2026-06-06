// =============================================================
// /api/admin-registration-update
//
// THIN ROUTER. Each action now lives in its own dedicated function
// file (admin-registration-<action>.js); this endpoint is kept so
// existing frontend calls don't break. It authenticates once, parses
// the body, and delegates to the matching action's core handler.
//
// POST with { action, ... }
//
// Actions → files:
//   confirm         → admin-registration-confirm.js
//   reject          → admin-registration-reject.js
//   reinstate       → admin-registration-reinstate.js
//   move-division   → admin-registration-move-division.js
//   move-player     → admin-registration-move-player.js
//   remove-player   → admin-registration-remove-player.js
//   delete          → admin-registration-delete.js
//   set-price       → admin-registration-set-price.js
//   add-payment / mark-paid → admin-registration-add-payment.js
//   edit-payment    → admin-registration-edit-payment.js
//   delete-payment  → admin-registration-delete-payment.js
//   edit-contact    → admin-registration-edit-contact.js
//
// Shared helpers (json, findRegistration, migratePayments,
// recalcPayments) live in lib/registrations.js.
// =============================================================

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json } from './lib/registrations.js';

import { run as confirm } from './admin-registration-confirm.js';
import { run as reject } from './admin-registration-reject.js';
import { run as reinstate } from './admin-registration-reinstate.js';
import { run as moveDivision } from './admin-registration-move-division.js';
import { run as movePlayer } from './admin-registration-move-player.js';
import { run as removePlayer } from './admin-registration-remove-player.js';
import { run as deleteRegistration } from './admin-registration-delete.js';
import { run as setPrice } from './admin-registration-set-price.js';
import { run as addPayment } from './admin-registration-add-payment.js';
import { run as editPayment } from './admin-registration-edit-payment.js';
import { run as deletePayment } from './admin-registration-delete-payment.js';
import { run as editContact } from './admin-registration-edit-contact.js';

const HANDLERS = {
  'confirm': confirm,
  'reject': reject,
  'reinstate': reinstate,
  'move-division': moveDivision,
  'move-player': movePlayer,
  'remove-player': removePlayer,
  'delete': deleteRegistration,
  'set-price': setPrice,
  'add-payment': addPayment,
  'mark-paid': addPayment, // alias — same handler as add-payment
  'edit-payment': editPayment,
  'delete-payment': deletePayment,
  'edit-contact': editContact,
};

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const body = await req.json();
  const { action } = body;

  const handler = HANDLERS[action];
  if (!handler) return json({ error: `Unknown action: ${action}` }, 400);

  return handler(body, admin);
};
