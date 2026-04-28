// netlify/functions/admin-settings.js
// GET  → return current circuit settings
// POST → save circuit settings (admin-only)

import { getStore } from '@netlify/blobs';
import { verifyAdmin } from './lib/admin-auth.js';
import { ok, err, noAuth } from './lib/response.js';

const STORE = 'config';
const KEY   = 'circuit-settings';

// Defaults — used when nothing is saved yet
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

export async function handler(event) {
  // GET is public (public pages need to read circuit name, venue, etc.)
  if (event.httpMethod === 'GET') {
    try {
      const store = getStore({ name: STORE, consistency: 'strong' });
      const raw = await store.get(KEY);
      const settings = raw ? JSON.parse(raw) : { ...DEFAULTS };
      return ok(settings);
    } catch (e) {
      console.error('settings GET error:', e);
      return ok({ ...DEFAULTS }); // graceful fallback
    }
  }

  // POST requires admin auth
  if (event.httpMethod === 'POST') {
    const admin = await verifyAdmin(event);
    if (!admin) return noAuth();

    try {
      const body = JSON.parse(event.body || '{}');

      // Merge with defaults so we never lose fields
      const store = getStore({ name: STORE, consistency: 'strong' });
      const existing = await store.get(KEY);
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

      await store.set(KEY, JSON.stringify(updated));
      return ok(updated);
    } catch (e) {
      console.error('settings POST error:', e);
      return err('Failed to save settings: ' + e.message);
    }
  }

  return err('Method not allowed', 405);
}
