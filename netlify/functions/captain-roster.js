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

const MAX_ROSTER_SIZE = 20;

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const store = getStore('teams');
  const teamKey = `team/${ctx.team.id}.json`;

  if (req.method === 'GET') {
    return json({ team: ctx.team });
  }

  if (req.method === 'PUT') {
    try {
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

        cleaned.push({
          id,
          name: name.slice(0, 60),
          gender,
          email: sanitize(p.email, 120),
          phone: sanitize(p.phone, 30),
          dupr: sanitize(p.dupr, 10),
          linkedUserId: p.linkedUserId || null,
        });
      }

      const updated = {
        ...ctx.team,
        roster: cleaned,
        rosterUpdatedAt: new Date().toISOString(),
      };
      await store.setJSON(teamKey, updated);

      return json({ team: updated });
    } catch (err) {
      console.error('captain-roster PUT error:', err);
      return json({ error: 'Save failed', detail: err.message }, 500);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

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
