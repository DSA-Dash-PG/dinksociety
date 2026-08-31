// netlify/functions/admin-registration-confirm.js
// 'confirm' action, split from admin-registration-update.js.
// Moves a pending registration → confirmed and creates the team record.
//
// POST { id, recordPayment?: { amount, method, note } }
//   (also callable via admin-registration-update with action:'confirm')
//
// recordPayment is used by the "Venmo received" button: it logs the deposit as
// a manual payment in the same call that confirms the spot. Venmo registrations
// also get their "You're in" email here, since no Stripe webhook fires for them.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration, migratePayments, recalcPayments } from './lib/registrations.js';
import { sendEmail } from './lib/email.js';
import { fmtDueDate } from './lib/payment-terms.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body, admin) {
  const regStore = getStore('registrations');
  const teamStore = getStore('teams');

  const { id } = body;
  if (!id) return json({ error: 'Registration id required' }, 400);

  const found = await findRegistration(regStore, id);
  if (!found) return json({ error: 'Registration not found' }, 404);

  const { reg, foundKey } = found;

  if (reg.status === 'confirmed') {
    return json({ ok: true, message: 'Already confirmed', registration: reg });
  }

  // Optionally log a payment (e.g. the Venmo deposit) as part of confirming.
  const rp = body.recordPayment;
  if (rp && parseFloat(rp.amount) > 0) {
    const VALID_METHODS = ['zelle', 'venmo', 'cash', 'other'];
    migratePayments(reg);
    reg.manualPayments.push({
      id: 'mp_' + Date.now(),
      amount: parseFloat(rp.amount),
      method: VALID_METHODS.includes(rp.method) ? rp.method : 'other',
      note: rp.note || '',
      paidAt: new Date().toISOString(),
      paidBy: admin.email,
    });
    recalcPayments(reg);
    if (reg.paymentType === 'deposit') reg.depositPaid = Math.min(reg.amountPaid, reg.depositAmount || reg.amountPaid);
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

  // Venmo registrations never hit the Stripe webhook, so the confirmation
  // email goes out from here.
  if (reg.paymentMethod === 'venmo') {
    await sendVenmoConfirmedEmail(reg);
  }

  return json({ ok: true, registration: reg });
}

async function sendVenmoConfirmedEmail(reg) {
  const isTeam = reg.path === 'team';
  const to = isTeam ? (reg.team?.players?.[0]?.email || '') : (reg.agent?.email || '');
  if (!to) return;
  const name = isTeam ? (reg.team?.captain || reg.team?.players?.[0]?.name || '') : (reg.agent?.name || '');
  const siteUrl = process.env.SITE_URL || '';
  const total = reg.totalPrice || reg.price || 0;
  const paid = reg.amountPaid || 0;
  const balance = reg.balanceDue != null ? reg.balanceDue : Math.max(0, total - paid);
  const dueLabel = fmtDueDate(reg.balanceDueDate);
  const seasonLabel = reg.circuit === 'I' ? 'Season 1' : (reg.circuit || 'the league');
  try {
    await sendEmail({
      to,
      subject: `You're in — ${seasonLabel} registration confirmed`,
      html: `
        <div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#0e0e0e;color:#f5f5f5;">
          <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#f5f5f5;margin-bottom:32px;">THE DINK SOCIETY</div>
          <h1 style="font-size:24px;font-weight:800;text-transform:uppercase;color:#f5f5f5;margin:0 0 8px;">You're in${name ? ', ' + name.split(' ')[0] : ''}.</h1>
          <p style="font-size:15px;color:#8a8a8a;line-height:1.6;margin:0 0 24px;">
            Venmo deposit received. ${isTeam ? `Your team <strong style="color:#f5f5f5;">${reg.team?.name || ''}</strong> is` : 'You are'} confirmed for <strong style="color:#f5f5f5;">${seasonLabel}</strong> (${reg.divisionLabel || reg.division}).
          </p>
          <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:24px;">
            <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#b8ff2c;margin-bottom:12px;font-weight:700;">Your membership</div>
            <table style="width:100%;font-size:14px;color:#f5f5f5;">
              <tr><td style="padding:6px 0;color:#8a8a8a;">Division</td><td style="padding:6px 0;text-align:right;font-weight:600;">${reg.divisionLabel || reg.division}</td></tr>
              ${isTeam ? `<tr><td style="padding:6px 0;color:#8a8a8a;">Team</td><td style="padding:6px 0;text-align:right;font-weight:600;">${reg.team?.name || '—'}</td></tr>` : ''}
              <tr><td style="padding:6px 0;color:#8a8a8a;">Team fee</td><td style="padding:6px 0;text-align:right;font-weight:600;">$${total}</td></tr>
              <tr><td style="padding:6px 0;color:#8a8a8a;">Paid (Venmo)</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#b8ff2c;">$${paid}</td></tr>
              <tr><td style="padding:6px 0;color:#8a8a8a;">Balance due${dueLabel ? ' by ' + dueLabel : ''}</td><td style="padding:6px 0;text-align:right;font-weight:600;">$${balance}</td></tr>
              <tr><td style="padding:6px 0;color:#8a8a8a;">Reference</td><td style="padding:6px 0;text-align:right;font-family:monospace;font-size:12px;color:#8a8a8a;">${String(reg.id || '').toUpperCase()}</td></tr>
            </table>
          </div>
          ${balance > 0 ? `
          <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #ffb400;padding:16px 20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
            <p style="font-size:14px;margin:0;line-height:1.6;color:#8a8a8a;">
              <strong style="color:#f5f5f5;">Balance reminder:</strong> the remaining $${balance} is due${dueLabel ? ' by ' + dueLabel : ' one week before the season starts'}${reg.venmo?.handle ? ` — Venmo <strong style="color:#f5f5f5;">@${reg.venmo.handle}</strong> works for that too` : ''}.
            </p>
          </div>` : ''}
          ${isTeam ? `
          <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-left:3px solid #b8ff2c;padding:20px;border-radius:0 12px 12px 0;margin-bottom:24px;">
            <p style="font-size:14px;margin:0 0 12px;line-height:1.6;color:#8a8a8a;">
              <strong style="color:#f5f5f5;">Next step:</strong> build your roster through the Captain Portal. Request a magic link at:
            </p>
            <a href="${siteUrl}/captain.html" style="color:#b8ff2c;font-weight:600;text-decoration:none;">${siteUrl}/captain.html</a>
          </div>` : ''}
          <div style="margin-top:40px;padding-top:20px;border-top:1px solid #2a2a2a;font-size:11px;color:#555;">
            The Dink Society · Southern California Pickleball League
          </div>
        </div>
      `,
    });
  } catch (emailErr) {
    console.error('Venmo confirmation email failed:', emailErr);
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  let body;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-confirm' };
