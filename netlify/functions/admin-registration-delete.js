// netlify/functions/admin-registration-delete.js
// 'delete' action, split from admin-registration-update.js.
// Permanently removes a registration and/or its team record.
//
// POST { id } and/or { teamId }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration } from './lib/registrations.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body) {
  const regStore = getStore('registrations');
  const teamStore = getStore('teams');

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

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const body = await req.json();
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-delete' };
