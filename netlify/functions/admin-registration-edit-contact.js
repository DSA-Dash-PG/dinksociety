// netlify/functions/admin-registration-edit-contact.js
// 'edit-contact' action, split from admin-registration-update.js.
// Edits the primary contact / captain (name + email). Updates the
// registration's contact AND syncs the team record's captainEmail +
// captain roster entry, so captain login keeps working after a roster swap.
//
// POST { id, email?, name? }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { json, findRegistration } from './lib/registrations.js';
import { logActivity } from './lib/activity-log.js';

// Core logic — also invoked by the admin-registration-update router.
export async function run(body, admin) {
  const regStore = getStore('registrations');
  const teamStore = getStore('teams');

  const { id } = body;
  const newEmail = (body.email || '').toString().trim().toLowerCase();
  const newName = (body.name || '').toString().trim();
  if (!id) return json({ error: 'id required' }, 400);
  if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return json({ error: 'Invalid email' }, 400);
  }

  const found = await findRegistration(regStore, id);
  if (!found) return json({ error: 'Registration not found' }, 404);
  const { reg, foundKey } = found;

  // Snapshot old contact for the activity log (old → new)
  const oldContact = reg.path === 'team' && reg.team
    ? { name: reg.team.players?.[0]?.name || reg.team.captain || null, email: reg.team.players?.[0]?.email || null }
    : { name: reg.agent?.name || null, email: reg.agent?.email || null };

  // Update the registration's primary contact slot
  if (reg.path === 'team' && reg.team) {
    if (!Array.isArray(reg.team.players) || !reg.team.players.length) {
      reg.team.players = [{ name: newName, email: newEmail }];
    } else {
      if (newEmail) reg.team.players[0].email = newEmail;
      if (newName) reg.team.players[0].name = newName;
    }
    if (newName) reg.team.captain = newName;
  } else if (reg.agent) {
    if (newEmail) reg.agent.email = newEmail;
    if (newName) reg.agent.name = newName;
  }
  reg.updatedAt = new Date().toISOString();
  await regStore.set(foundKey, JSON.stringify(reg));

  // Sync the team record (keyed team/team_<regId>.json, or reg.teamId)
  let teamSynced = false;
  let syncedTeam = null;
  const teamKeys = [`team/team_${id}.json`];
  if (reg.teamId) teamKeys.push(`team/${reg.teamId}.json`);
  for (const key of teamKeys) {
    try {
      const team = await teamStore.get(key, { type: 'json' });
      if (!team) continue;
      if (newEmail) team.captainEmail = newEmail;
      const roster = team.roster || [];
      let cap = roster.find(p => p.isCaptain) || roster[0];
      if (cap) {
        if (newEmail) cap.email = newEmail;
        if (newName) cap.name = newName;
      }
      if (newName) team.captain = newName;
      team.updatedAt = new Date().toISOString();
      team.updatedBy = admin.email;
      await teamStore.setJSON(key, team);
      teamSynced = true;
      syncedTeam = team;
      break;
    } catch { /* try next key */ }
  }

  const changes = [];
  if (newName && newName !== oldContact.name) changes.push(`name "${oldContact.name || '—'}" → "${newName}"`);
  if (newEmail && newEmail !== (oldContact.email || '').toLowerCase()) changes.push(`email ${oldContact.email || '—'} → ${newEmail}`);
  if (changes.length) {
    await logActivity({
      type: 'contact.updated',
      actor: { email: admin?.email || null, role: 'admin' },
      team: syncedTeam,
      player: { id: null, name: newName || oldContact.name },
      details: `Contact updated for ${newName || oldContact.name || 'registration ' + id}: ${changes.join(', ')}`,
    });
  }

  return json({ ok: true, registration: reg, teamSynced });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const body = await req.json();
  return run(body, verified.payload);
};

export const config = { path: '/.netlify/functions/admin-registration-edit-contact' };
