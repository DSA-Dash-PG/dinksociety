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

  // Update the corresponding team record too. Registrations never carry a
  // teamId — the confirm flow writes `team_<regId>` with registrationId, the
  // seed flow writes a slug id with seededFromRegistrationId — so scan for it.
  let teamUpdated = null;
  if (reg.path === 'team') {
    const captainEmail = (reg.team?.players?.[0]?.email || '').toLowerCase().trim();
    const { blobs } = await teamStore.list({ prefix: 'team/' });
    for (const b of blobs) {
      const team = await teamStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!team) continue;
      const linked = team.registrationId === id || team.seededFromRegistrationId === id;
      const sameCaptain = captainEmail && (team.captainEmail || '').toLowerCase().trim() === captainEmail
        && (!reg.seasonId || !team.seasonId || team.seasonId === reg.seasonId);
      if (!linked && !sameCaptain) continue;
      team.division = newDivision;
      if (body.newDivisionLabel) team.divisionLabel = body.newDivisionLabel;
      team.updatedAt = reg.updatedAt;
      await teamStore.setJSON(b.key, team);
      teamUpdated = team.id;
      break;
    }
  }
  if (body.newDivisionLabel) {
    reg.divisionLabel = body.newDivisionLabel;
    await regStore.set(foundKey, JSON.stringify(reg));
  }

  return json({ ok: true, registration: reg, teamUpdated, moved: { from: oldDivision, to: newDivision } });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const body = await req.json();
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-move-division' };
