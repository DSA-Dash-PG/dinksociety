// netlify/functions/admin-registration-confirm.js
// 'confirm' action, split from admin-registration-update.js.
// Moves a pending registration → confirmed and creates the team record.
//
// POST { id }   (also callable via admin-registration-update with action:'confirm')

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration } from './lib/registrations.js';

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
