// =============================================================
// /api/admin-seasons
//
// Season & division management for the admin portal.
//
// GET    → list all seasons
// POST   → create a new season
// PATCH  → update season (status, registration, add/remove divisions)
// DELETE → archive a season
//
// Data shape (stored in Netlify Blobs 'seasons' store):
//   key: season id (e.g. "circuit-1")
//   value: {
//     id, name, label,          // "circuit-1", "Circuit I", "Circuit I (May 2026)"
//     status,                   // draft | open | paused | closed | archived
//     registration,             // open | paused | closed
//     startDate, endDate,       // ISO strings (optional)
//     divisions: [
//       { id, name, capacity, teamPrice, agentPrice, stripeTeamPriceId, stripeAgentPriceId }
//     ],
//     createdAt, updatedAt
//   }
// =============================================================

import { getStore } from '@netlify/blobs';
import { requireAdmin, unauthResponse } from './lib/admin-auth.js';

const STORE_NAME = 'seasons';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function getAllSeasons() {
  const store = getStore(STORE_NAME);
  const { blobs } = await store.list();
  const seasons = [];
  for (const blob of blobs) {
    const raw = await store.get(blob.key);
    if (raw) {
      try {
        seasons.push(JSON.parse(raw));
      } catch {}
    }
  }
  // Sort: active first, then by createdAt desc
  const statusOrder = { open: 0, paused: 1, draft: 2, closed: 3, archived: 4 };
  seasons.sort((a, b) => {
    const sa = statusOrder[a.status] ?? 5;
    const sb = statusOrder[b.status] ?? 5;
    if (sa !== sb) return sa - sb;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  return seasons;
}

export default async (req) => {
  try {
    await requireAdmin(req);
  } catch {
    return unauthResponse();
  }

  const store = getStore(STORE_NAME);

  // ─── GET: list all seasons ───
  if (req.method === 'GET') {
    const seasons = await getAllSeasons();
    return json({ seasons });
  }

  // ─── POST: create season ───
  if (req.method === 'POST') {
    const body = await req.json();
    const { name, label, startDate, endDate } = body;

    if (!name || !name.trim()) {
      return json({ error: 'Season name is required' }, 400);
    }

    const id = slugify(name);

    // Check for duplicate
    const existing = await store.get(id);
    if (existing) {
      return json({ error: `A season with id "${id}" already exists` }, 409);
    }

    const season = {
      id,
      name: name.trim(),
      label: (label || name).trim(),
      status: 'draft',
      registration: 'closed',
      startDate: startDate || null,
      endDate: endDate || null,
      divisions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.set(id, JSON.stringify(season));
    return json({ season }, 201);
  }

  // ─── PATCH: update season ───
  if (req.method === 'PATCH') {
    const body = await req.json();
    const { id, action, ...payload } = body;

    if (!id) return json({ error: 'Season id is required' }, 400);

    const raw = await store.get(id);
    if (!raw) return json({ error: 'Season not found' }, 404);

    const season = JSON.parse(raw);

    switch (action) {
      // Update basic fields
      case 'update': {
        if (payload.name) season.name = payload.name.trim();
        if (payload.label) season.label = payload.label.trim();
        if (payload.startDate !== undefined) season.startDate = payload.startDate;
        if (payload.endDate !== undefined) season.endDate = payload.endDate;
        break;
      }

      // Change season status
      case 'set-status': {
        const valid = ['draft', 'open', 'paused', 'closed', 'archived'];
        if (!valid.includes(payload.status)) {
          return json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` }, 400);
        }
        season.status = payload.status;
        // Auto-close registration if season is archived/closed
        if (['archived', 'closed'].includes(payload.status)) {
          season.registration = 'closed';
        }
        break;
      }

      // Change registration status
      case 'set-registration': {
        const valid = ['open', 'paused', 'closed'];
        if (!valid.includes(payload.registration)) {
          return json({ error: 'Invalid registration status' }, 400);
        }
        // Can only open registration if season is open or draft
        if (payload.registration === 'open' && !['draft', 'open'].includes(season.status)) {
          return json({ error: 'Cannot open registration for a closed/archived season' }, 400);
        }
        season.registration = payload.registration;
        // If opening registration, also set season to open
        if (payload.registration === 'open' && season.status === 'draft') {
          season.status = 'open';
        }
        break;
      }

      // Add a division
      case 'add-division': {
        const { divName, capacity, teamPrice, agentPrice } = payload;
        if (!divName) return json({ error: 'Division name is required' }, 400);

        const divId = slugify(divName);
        if (season.divisions.find((d) => d.id === divId)) {
          return json({ error: `Division "${divName}" already exists in this season` }, 409);
        }

        season.divisions.push({
          id: divId,
          name: divName.trim(),
          capacity: parseInt(capacity) || 6,
          teamPrice: parseFloat(teamPrice) || 450,
          agentPrice: parseFloat(agentPrice) || 75,
          stripeTeamPriceId: null,
          stripeAgentPriceId: null,
        });
        break;
      }

      // Update a division
      case 'update-division': {
        const { divId } = payload;
        const div = season.divisions.find((d) => d.id === divId);
        if (!div) return json({ error: 'Division not found' }, 404);

        if (payload.divName) div.name = payload.divName.trim();
        if (payload.capacity) div.capacity = parseInt(payload.capacity);
        if (payload.teamPrice) div.teamPrice = parseFloat(payload.teamPrice);
        if (payload.agentPrice) div.agentPrice = parseFloat(payload.agentPrice);
        break;
      }

      // Remove a division
      case 'remove-division': {
        const { divId } = payload;
        const idx = season.divisions.findIndex((d) => d.id === divId);
        if (idx === -1) return json({ error: 'Division not found' }, 404);
        season.divisions.splice(idx, 1);
        break;
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }

    season.updatedAt = new Date().toISOString();
    await store.set(id, JSON.stringify(season));
    return json({ season });
  }

  // ─── DELETE: archive a season ───
  if (req.method === 'DELETE') {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'Season id is required' }, 400);

    const raw = await store.get(id);
    if (!raw) return json({ error: 'Season not found' }, 404);

    const season = JSON.parse(raw);
    season.status = 'archived';
    season.registration = 'closed';
    season.updatedAt = new Date().toISOString();
    await store.set(id, JSON.stringify(season));

    return json({ ok: true, season });
  }

  return new Response('Method not allowed', { status: 405 });
};
