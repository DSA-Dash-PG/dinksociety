// netlify/functions/captain-team-emoji.js
// POST { emoji }  → set the captain's own team emoji. Lightweight (no roster
// validation) so a captain can set their emoji even if the roster is mid-edit.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const result = await verifyCaptainSession(req);
  if (!result.valid) return unauthResponse(result.error);
  const ctx = result.payload;

  try {
    const body = await req.json();
    const emoji = (body.emoji || '').toString().trim().slice(0, 8);

    const store = getStore('teams');
    const teamKey = `team/${ctx.team.id}.json`;
    const team = await store.get(teamKey, { type: 'json' }).catch(() => null) || ctx.team;
    team.emoji = emoji;
    team.updatedAt = new Date().toISOString();
    await store.setJSON(teamKey, team);

    return json({ ok: true, emoji });
  } catch (err) {
    console.error('captain-team-emoji error:', err);
    return json({ error: 'Save failed', detail: err.message }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-team-emoji' };
