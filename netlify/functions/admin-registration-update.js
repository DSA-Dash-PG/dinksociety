// netlify/functions/admin-registration-update.js
// PATCH a registration: approve (pending→confirmed), reject, or change division.
// Also supports updating a team's division in the teams blob store if already seeded.
//
// Body: { id, action, division? }
//   action: "approve" | "reject" | "move"
//   division: required for "move", e.g. "3.0M", "3.5M", "3.5W"

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

const VALID_DIVISIONS = ['3.0M', '3.5M', '3.5W'];
const DIVISION_LABELS = {
  '3.0M': '3.0 Mixed',
  '3.5M': '3.5 Mixed',
  '3.5W': "3.5 Women's",
};

export default async (req) => {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const admin = await requireAdmin(req);
  if (!admin) return unauthResponse();

  try {
    const { id, action, division } = await req.json();

    if (!id || !action) {
      return json({ error: 'id and action required' }, 400);
    }

    if (!['approve', 'reject', 'move'].includes(action)) {
      return json({ error: 'action must be approve, reject, or move' }, 400);
    }

    if (action === 'move' && (!division || !VALID_DIVISIONS.includes(division))) {
      return json({ error: `division must be one of: ${VALID_DIVISIONS.join(', ')}` }, 400);
    }

    const store = getStore('registrations');

    // Find the registration — could be in confirmed/ or pending/
    let reg = null;
    let currentKey = null;

    for (const prefix of ['confirmed/', 'pending/']) {
      const key = `${prefix}${id}.json`;
      const data = await store.get(key, { type: 'json' }).catch(() => null);
      if (data) {
        reg = data;
        currentKey = key;
        break;
      }
    }

    if (!reg) {
      return json({ error: 'Registration not found' }, 404);
    }

    // === APPROVE ===
    if (action === 'approve') {
      if (reg.status === 'confirmed') {
        return json({ ok: true, message: 'Already confirmed', registration: reg });
      }

      // Move from pending/ to confirmed/
      reg.status = 'confirmed';
      reg.confirmedAt = new Date().toISOString();
      reg.approvedBy = admin.email;

      const newKey = `confirmed/${id}.json`;
      await store.setJSON(newKey, reg);

      // Delete the old pending key if it was in pending/
      if (currentKey.startsWith('pending/')) {
        await store.delete(currentKey).catch(() => null);
      }

      return json({ ok: true, message: 'Registration approved', registration: reg });
    }

    // === REJECT ===
    if (action === 'reject') {
      reg.status = 'rejected';
      reg.rejectedAt = new Date().toISOString();
      reg.rejectedBy = admin.email;

      // Move to a rejected/ prefix so it doesn't show in confirmed or pending
      const newKey = `rejected/${id}.json`;
      await store.setJSON(newKey, reg);

      // Delete from old location
      if (currentKey !== newKey) {
        await store.delete(currentKey).catch(() => null);
      }

      return json({ ok: true, message: 'Registration rejected', registration: reg });
    }

    // === MOVE (change division) ===
    if (action === 'move') {
      const oldDivision = reg.division;
      reg.division = division;
      reg.divisionLabel = DIVISION_LABELS[division] || division;
      reg.movedAt = new Date().toISOString();
      reg.movedBy = admin.email;

      // Save back to the same key
      await store.setJSON(currentKey, reg);

      // If the team has already been seeded, update the team record too
      if (reg.path === 'team' && reg.team?.name) {
        await updateTeamDivision(reg, division, oldDivision);
      }

      return json({
        ok: true,
        message: `Moved from ${oldDivision} to ${division}`,
        registration: reg,
      });
    }
  } catch (err) {
    console.error('admin-registration-update error:', err);
    return json({ error: 'Update failed: ' + err.message }, 500);
  }
};

/**
 * If a team record exists in the teams store, update its division.
 */
async function updateTeamDivision(reg, newDivision, oldDivision) {
  const teamsStore = getStore('teams');
  const { blobs } = await teamsStore.list({ prefix: 'team/' });

  for (const b of blobs) {
    const team = await teamsStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!team) continue;

    // Match by captain email or team name
    const captainEmail = reg.team?.players?.[0]?.email?.toLowerCase();
    const teamCaptainEmail = (team.captainEmail || '').toLowerCase();

    if (
      (captainEmail && teamCaptainEmail === captainEmail) ||
      (team.name === reg.team?.name)
    ) {
      team.division = newDivision;
      team.divisionLabel = DIVISION_LABELS[newDivision] || newDivision;
      team.divisionMovedAt = new Date().toISOString();
      team.previousDivision = oldDivision;
      await teamsStore.setJSON(b.key, team);
      console.log(`Updated team "${team.name}" division: ${oldDivision} → ${newDivision}`);
      break;
    }
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
  });
}

export const config = { path: '/.netlify/functions/admin-registration-update' };
