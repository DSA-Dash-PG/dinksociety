// netlify/functions/admin-settings.js
// GET  → return current circuit settings (public, no auth)
// POST → save circuit settings (admin-only)

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

const DEFAULTS = {
  circuitName:    'Circuit I',
  startDate:      '2026-05-12',
  teamFee:        '$450',
  agentFee:       '$75',
  defaultVenue:   'South Bay Pickleball Courts',
  divisions:      ['3.0 Mixed', '3.5 Mixed'],
  teamsPerDiv:    6,
  weeks:          7,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (req) => {
  const store = getStore({ name: 'config', consistency: 'strong' });

  // GET — public, no auth needed
  if (req.method === 'GET') {
    try {
      const raw = await store.get('circuit-settings');
      return json(raw ? JSON.parse(raw) : { ...DEFAULTS });
    } catch (e) {
      console.error('settings GET error:', e);
      return json({ ...DEFAULTS });
    }
  }

  // POST — admin only
  if (req.method === 'POST') {
    let admin;
    try {
      admin = await requireAdmin(req);
    } catch {
      return unauthResponse();
    }

    try {
      const body = await req.json();
      const existing = await store.get('circuit-settings');
      const prev = existing ? JSON.parse(existing) : { ...DEFAULTS };

      const updated = {
        ...prev,
        circuitName:  body.circuitName  ?? prev.circuitName,
        startDate:    body.startDate    ?? prev.startDate,
        teamFee:      body.teamFee      ?? prev.teamFee,
        agentFee:     body.agentFee     ?? prev.agentFee,
        defaultVenue: body.defaultVenue ?? prev.defaultVenue,
        divisions:    body.divisions    ?? prev.divisions,
        teamsPerDiv:  body.teamsPerDiv  ?? prev.teamsPerDiv,
        weeks:        body.weeks        ?? prev.weeks,
        updatedAt:    new Date().toISOString(),
        updatedBy:    admin.email || 'admin',
      };

      await store.set('circuit-settings', JSON.stringify(updated));
      return json(updated);
    } catch (e) {
      console.error('settings POST error:', e);
      return json({ error: 'Failed to save settings' }, 500);
    }
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/admin-settings' };
