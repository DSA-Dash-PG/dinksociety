// =============================================================
// /api/admin-registration-update
//
// Manage individual registrations: confirm, reject, reinstate,
// move to different division, move players between teams,
// and manage payments.
//
// POST with { action, ... }
//
// Actions:
//   confirm    { id }                  → moves pending → confirmed, creates team
//   reject     { id, reason }          → marks registration as rejected
//   reinstate  { id }                  → marks rejected registration back to confirmed
//   move-division { id, newDivision }  → moves a team/agent to a different division
//   move-player   { playerId, fromTeamId, toTeamId } → moves a player between teams
//   remove-player { playerId, teamId } → removes a player from a team
//   delete     { id } and/or { teamId } → permanently removes a registration + its team
//   set-price  { id, price }           → override totalPrice, recalculate balance
//   add-payment / mark-paid { id, amount, method, note } → add manual payment entry
//   edit-payment { id, paymentId, amount, method, note } → update a payment entry
//   delete-payment { id, paymentId }   → remove a payment entry
// =============================================================

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Ensure reg.manualPayments is an array, migrating the legacy single-object
 * manualPayment field if present.
 */
function migratePayments(reg) {
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
function recalcPayments(reg) {
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
async function findRegistration(regStore, id) {
  const prefixes = [`pending/${id}.json`, `confirmed/${id}.json`, `rejected/${id}.json`, id];
  for (const key of prefixes) {
    try {
      const raw = await regStore.get(key);
      if (raw) return { reg: JSON.parse(raw), foundKey: key };
    } catch { /* not found, try next */ }
  }
  return null;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let admin;
  try {
    admin = await requireAdmin(req);
  } catch {
    return unauthResponse();
  }

  const body = await req.json();
  const { action } = body;

  const regStore = getStore('registrations');
  const teamStore = getStore('teams');
  const seasonStore = getStore('seasons');

  switch (action) {
    // ─── Confirm a pending registration ───
    case 'confirm': {
      const { id } = body;
      if (!id) return json({ error: 'Registration id required' }, 400);

      const found = await findRegistration(regStore, id);
      if (!found) return json({ error: 'Registration not found' }, 404);

      const { reg, foundKey } = found;

      if (reg.status === 'confirmed') {
        return json({ ok: true, message: 'Already confirmed', registration: reg });
      }

      // Mark as confirmed
      reg.status = 'confirmed';
      reg.confirmedAt = new Date().toISOString();
      reg.approvedBy = admin.email;

      // Write to confirmed/ prefix
      const confirmedKey = `confirmed/${id}.json`;
      await regStore.set(confirmedKey, JSON.stringify(reg));

      // Delete the old key if different
      if (foundKey !== confirmedKey) {
        try { await regStore.delete(foundKey); } catch { /* ok */ }
      }

      // Create team record in teams store (so captain magic-link works)
      if (reg.path === 'team' && reg.team?.name) {
        try {
          const teamId = `team_${id}`;
          const captainEmail = (reg.team.players?.[0]?.email || '').toLowerCase().trim();
          const teamRecord = {
            id: teamId,
            name: reg.team.name,
            captainName: reg.team.captain || reg.team.players?.[0]?.name || null,
            captainEmail: captainEmail || null,
            division: reg.division || null,
            divisionLabel: reg.divisionLabel || null,
            circuit: reg.circuit || 'I',
            roster: (reg.team.players || []).map((p, i) => ({
              id: `p_${id}_${i}`,
              name: p.name || '',
              gender: '',
              email: p.email || '',
              phone: p.phone || '',
              dupr: '',
              isCaptain: i === 0,
            })),
            registrationId: id,
            createdAt: new Date().toISOString(),
            createdBy: admin.email,
            status: 'active',
          };
          await teamStore.setJSON(`team/${teamId}.json`, teamRecord);
          console.log(`Team created via admin confirm: ${teamId} (${reg.team.name})`);
        } catch (teamErr) {
          console.error('Failed to create team on confirm:', teamErr);
        }
      }

      return json({ ok: true, registration: reg });
    }

    // ─── Reject a registration ───
    case 'reject': {
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

    // ─── Reinstate a rejected registration ───
    case 'reinstate': {
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

    // ─── Move to a different division ───
    case 'move-division': {
      const { id, newDivision } = body;
      if (!id || !newDivision) return json({ error: 'Registration id and newDivision required' }, 400);

      const found = await findRegistration(regStore, id);
      if (!found) return json({ error: 'Registration not found' }, 404);

      const { reg, foundKey } = found;
      const oldDivision = reg.division;
      reg.division = newDivision;
      reg.updatedAt = new Date().toISOString();
      await regStore.set(foundKey, JSON.stringify(reg));

      // If there's a corresponding team record, update it too
      if (reg.path === 'team' && reg.teamId) {
        const teamRaw = await teamStore.get(reg.teamId);
        if (teamRaw) {
          const team = JSON.parse(teamRaw);
          team.division = newDivision;
          team.updatedAt = new Date().toISOString();
          await teamStore.set(reg.teamId, JSON.stringify(team));
        }
      }

      return json({ ok: true, registration: reg, moved: { from: oldDivision, to: newDivision } });
    }

    // ─── Move a player between teams ───
    case 'move-player': {
      const { playerId, fromTeamId, toTeamId } = body;
      if (!playerId || !fromTeamId || !toTeamId) {
        return json({ error: 'playerId, fromTeamId, and toTeamId are all required' }, 400);
      }

      // Load source team
      const fromRaw = await teamStore.get(fromTeamId);
      if (!fromRaw) return json({ error: 'Source team not found' }, 404);
      const fromTeam = JSON.parse(fromRaw);

      // Load destination team
      const toRaw = await teamStore.get(toTeamId);
      if (!toRaw) return json({ error: 'Destination team not found' }, 404);
      const toTeam = JSON.parse(toRaw);

      // Find the player in source roster
      const roster = fromTeam.roster || [];
      const playerIdx = roster.findIndex((p) => p.id === playerId);
      if (playerIdx === -1) return json({ error: 'Player not found on source team' }, 404);

      // Check destination capacity
      const toRoster = toTeam.roster || [];
      const seasonData = toTeam.seasonId
        ? await seasonStore.get(toTeam.seasonId, { type: 'json' }).catch(() => null)
        : null;
      const maxRoster = seasonData?.maxRosterSize || 10;
      if (toRoster.length >= maxRoster) {
        return json({ error: `Destination team is at max capacity (${maxRoster} players)` }, 400);
      }

      // Move
      const [player] = roster.splice(playerIdx, 1);
      toRoster.push(player);

      fromTeam.roster = roster;
      fromTeam.updatedAt = new Date().toISOString();
      toTeam.roster = toRoster;
      toTeam.updatedAt = new Date().toISOString();

      await teamStore.set(fromTeamId, JSON.stringify(fromTeam));
      await teamStore.set(toTeamId, JSON.stringify(toTeam));

      return json({
        ok: true,
        player,
        from: { id: fromTeamId, name: fromTeam.name, rosterCount: roster.length },
        to: { id: toTeamId, name: toTeam.name, rosterCount: toRoster.length },
      });
    }

    // ─── Remove a player from a team ───
    case 'remove-player': {
      const { playerId, teamId } = body;
      if (!playerId || !teamId) return json({ error: 'playerId and teamId required' }, 400);

      const teamRaw = await teamStore.get(teamId);
      if (!teamRaw) return json({ error: 'Team not found' }, 404);
      const team = JSON.parse(teamRaw);

      const roster = team.roster || [];
      const playerIdx = roster.findIndex((p) => p.id === playerId);
      if (playerIdx === -1) return json({ error: 'Player not found on team' }, 404);

      // Don't allow removing below minimum
      if (roster.length <= 4) {
        return json({ error: 'Cannot remove — team is already at minimum roster size (4)' }, 400);
      }

      const [removed] = roster.splice(playerIdx, 1);
      team.roster = roster;
      team.updatedAt = new Date().toISOString();
      await teamStore.set(teamId, JSON.stringify(team));

      return json({ ok: true, removed, rosterCount: roster.length });
    }

    // ─── Permanently delete a registration (and its team) ───
    case 'delete': {
      const { id, teamId } = body;
      if (!id && !teamId) return json({ error: 'Registration id or teamId required' }, 400);

      let regId = id || null;
      let deletedReg = false;
      let deletedTeam = false;

      // If only a teamId was supplied, resolve its registrationId.
      if (!regId && teamId) {
        try {
          const teamRaw = await teamStore.get(`team/${teamId}.json`);
          if (teamRaw) regId = JSON.parse(teamRaw).registrationId || null;
        } catch { /* ok */ }
      }

      // Delete the registration blob, wherever it lives.
      if (regId) {
        const found = await findRegistration(regStore, regId);
        if (found) {
          try { await regStore.delete(found.foundKey); deletedReg = true; } catch { /* ok */ }
        }
      }

      // Delete the team record. Teams are keyed team/team_<regId>.json,
      // or use the explicit teamId if one was passed in.
      const teamKeys = [];
      if (teamId) teamKeys.push(`team/${teamId}.json`);
      if (regId) teamKeys.push(`team/team_${regId}.json`);
      for (const key of teamKeys) {
        try {
          const existing = await teamStore.get(key);
          if (existing) { await teamStore.delete(key); deletedTeam = true; }
        } catch { /* ok */ }
      }

      if (!deletedReg && !deletedTeam) {
        return json({ error: 'Nothing found to delete' }, 404);
      }
      return json({ ok: true, deletedReg, deletedTeam });
    }

    // ─── Override total price ───
    case 'set-price': {
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

    // ─── Add a manual payment entry ───
    case 'add-payment':
    case 'mark-paid': {
      const { id, amount, method, note } = body;
      if (!id) return json({ error: 'id required' }, 400);
      const VALID_METHODS = ['zelle', 'venmo', 'cash', 'other'];
      const payMethod = VALID_METHODS.includes(method) ? method : 'other';
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt <= 0) return json({ error: 'Invalid amount' }, 400);

      const found = await findRegistration(regStore, id);
      if (!found) return json({ error: 'Registration not found' }, 404);
      const { reg, foundKey } = found;

      migratePayments(reg);
      reg.manualPayments.push({
        id: 'mp_' + Date.now(),
        amount: amt,
        method: payMethod,
        note: note || '',
        paidAt: new Date().toISOString(),
        paidBy: admin.email,
      });
      recalcPayments(reg);
      await regStore.set(foundKey, JSON.stringify(reg));
      return json({ ok: true, registration: reg });
    }

    // ─── Edit a manual payment entry ───
    case 'edit-payment': {
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

    // ─── Delete a manual payment entry ───
    case 'delete-payment': {
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

    default:
      return json({ error: `Unknown action: ${action}` }, 400);
  }
};
