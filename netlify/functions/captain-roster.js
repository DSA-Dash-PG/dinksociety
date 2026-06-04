// netlify/functions/captain-roster.js
// GET:  returns captain's team + full roster
// PUT:  replaces the team's roster
//
// Roster entry shape:
//   { id, name, gender: 'M' | 'F', email?, phone?, dupr?, linkedUserId? }
//
// gender is REQUIRED because it's used for slot enforcement in lineups.

import { getStore } from '@netlify/blobs';
import { requireCaptain, unauthResponse } from './lib/captain-auth.js';
import { normalizeEmail, normalizePhone, findContactCollisions } from './lib/identity.js';

const MAX_ROSTER_SIZE = 20;

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const store = getStore('teams');
  const teamKey = `team/${ctx.team.id}.json`;

  if (req.method === 'GET') {
    const rosterLocked = await isRosterLocked(ctx.team);
    return json({ team: ctx.team, rosterLocked });
  }

  if (req.method === 'PUT') {
    try {
      // Roster locks once the team's Week 2 match is complete, unless an admin
      // has set the per-team unlock flag. Server-enforced so it can't be bypassed.
      if (await isRosterLocked(ctx.team)) {
        return json({ error: 'Your roster is locked for the season (Week 2 has been played). Ask a league admin to unlock it if you need a change.' }, 423);
      }

      const body = await req.json();
      const roster = Array.isArray(body.roster) ? body.roster : [];

      if (roster.length > MAX_ROSTER_SIZE) {
        return json({ error: `Roster cannot exceed ${MAX_ROSTER_SIZE} players` }, 400);
      }

      // Validate each entry
      const cleaned = [];
      const ids = new Set();
      for (const p of roster) {
        if (!p || typeof p !== 'object') continue;
        const name = (p.name || '').toString().trim();
        const gender = (p.gender || '').toString().toUpperCase();
        if (!name) return json({ error: 'Every player needs a name' }, 400);
        if (!['M', 'F'].includes(gender)) {
          return json({ error: `Player "${name}" needs a gender (M or F)` }, 400);
        }

        const id = p.id || generateId();
        if (ids.has(id)) return json({ error: 'Duplicate player id' }, 400);
        ids.add(id);

        const email = sanitize(p.email, 120);
        const phone = sanitize(p.phone, 30);
        cleaned.push({
          id,
          name: name.slice(0, 60),
          gender,
          email,
          phone,
          // Normalized contact keys — recomputed on every save so they never
          // drift from the raw values. Used by the duplicate sweep.
          normalizedEmail: normalizeEmail(email),
          normalizedPhone: normalizePhone(phone),
          dupr: sanitize(p.dupr, 10),
          linkedUserId: p.linkedUserId || null,
        });
      }

      // Flag (don't block) likely-duplicate people on this roster — two entries
      // sharing a normalized email or phone. Shared household contact info is a
      // legitimate (if rare) case, so we surface it for the captain to confirm
      // rather than rejecting the save.
      const duplicateWarnings = findContactCollisions(cleaned);

      const updated = {
        ...ctx.team,
        ...(typeof body.emoji === 'string' ? { emoji: body.emoji.trim().slice(0, 8) } : {}),
        roster: cleaned,
        rosterUpdatedAt: new Date().toISOString(),
      };
      await store.setJSON(teamKey, updated);

      return json({ team: updated, duplicateWarnings });
    } catch (err) {
      console.error('captain-roster PUT error:', err);
      return json({ error: 'Save failed', detail: err.message }, 500);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

/**
 * Roster locks once the team's Week 2 match has been finalized.
 * Admin can reopen it per-team by setting team.rosterUnlocked = true.
 */
async function isRosterLocked(team) {
  if (!team) return false;
  if (team.rosterUnlocked === true) return false; // admin override
  try {
    const scheduleStore = getStore('schedule');
    const key = `schedule/${team.circuit}/${team.division}/week-2.json`;
    const data = await scheduleStore.get(key, { type: 'json' }).catch(() => null);
    if (!data?.matches) return false;
    const m = data.matches.find(x => x.teamA?.id === team.id || x.teamB?.id === team.id);
    return !!(m && m.finalizedAt);
  } catch {
    return false; // never block a save because the lock check itself errored
  }
}

function sanitize(val, maxLen) {
  if (!val) return null;
  return String(val).trim().slice(0, maxLen) || null;
}

function generateId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'p_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-roster' };
