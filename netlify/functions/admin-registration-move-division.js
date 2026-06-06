// netlify/functions/admin-registration-move-division.js
// 'move-division' action, split from admin-registration-update.js.
// Moves a team/agent registration to a different division.
//
// POST { id, newDivision }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration } from './lib/registrations.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body) {
  const regStore = getStore('registrations');
  const teamStore = getStore('teams');

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

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const body = await req.json();
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-move-division' };
