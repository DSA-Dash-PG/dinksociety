// netlify/functions/admin-duplicates.js
//
// Admin-only duplicate-player sweep. Scans every team roster, normalizes each
// player's email/phone, and returns clusters of roster entries that share a
// normalized email or phone — i.e. probable duplicate people.
//
// This is the "cure" half of duplicate handling (the "prevent" half lives in
// captain-roster.js / admin-teams.js, which flag collisions at save time).
//
// Normalization is recomputed here on the fly, so the sweep works on legacy
// roster entries saved before normalizedEmail/normalizedPhone existed — no
// backfill/migration required.
//
// GET                       → sweep all teams in all seasons
// GET ?seasonId=<id>        → restrict the sweep to one season
//
// Response: {
//   clusters: [{
//     field: 'email' | 'phone',
//     value: '<normalized value>',          // contact value redacted-ish (kept for admin use)
//     sameSeason: boolean,                   // true => almost certainly a real duplicate to merge
//     linked: boolean,                       // are these ids currently ONE person?
//     members: [{ playerId, name, teamId, teamName, seasonId, email, phone }]
//   }],
//   scannedTeams, scannedPlayers, clusterCount
// }
//
// Shared EMAIL is treated as the same person automatically (lib/league-identity.js
// merges their stats and history on read). Shared PHONE is not — plenty of
// couples share a number — so a phone-only cluster stays separate until an admin
// links it here.
//
// POST { action, ... } — the admin overrides, both directions:
//   { action: 'link',     fromId, toId }  → same person despite different emails
//   { action: 'unlink',   fromId }        → undo that
//   { action: 'separate', idA, idB }      → different people despite a shared inbox
//   { action: 'rejoin',   idA, idB }      → undo that
//
// These write only the small `league-identity` map. Roster ids, player-stats and
// player-history are never rewritten, so any decision here is reversible.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { normalizeEmail, normalizePhone } from './lib/identity.js';
import {
  getIdentityMap, setLink, removeLink, setSeparate, removeSeparate,
  groupEntries, listRosterEntries,
} from './lib/league-identity.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  if (req.method === 'POST') return handleAction(req);
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const seasonFilter = url.searchParams.get('seasonId');

  const teamsStore = getStore('teams');
  const { blobs } = await teamsStore.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));

  const byEmail = new Map(); // normalizedEmail -> [member]
  const byPhone = new Map(); // normalizedPhone -> [member]
  let scannedTeams = 0;
  let scannedPlayers = 0;

  for (const b of blobs) {
    const team = await teamsStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!team) continue;
    if (seasonFilter && team.seasonId !== seasonFilter) continue;
    scannedTeams++;

    for (const p of team.roster || []) {
      scannedPlayers++;
      const member = {
        playerId: p.id,
        name: p.name || null,
        teamId: team.id,
        teamName: team.name || null,
        seasonId: team.seasonId || null,
        email: p.email || null,
        phone: p.phone || null,
      };
      const ne = normalizeEmail(p.email);
      const np = normalizePhone(p.phone);
      if (ne) {
        if (!byEmail.has(ne)) byEmail.set(ne, []);
        byEmail.get(ne).push(member);
      }
      if (np) {
        if (!byPhone.has(np)) byPhone.set(np, []);
        byPhone.get(np).push(member);
      }
    }
  }

  const clusters = [];
  collect(byEmail, 'email', clusters);
  collect(byPhone, 'phone', clusters);

  // Mark which clusters are currently treated as ONE person, so the UI can show
  // "Linked" vs "Separate" rather than making the admin guess.
  const map = await getIdentityMap();
  const { canonicalOf } = groupEntries(await listRosterEntries(), map);
  for (const c of clusters) {
    const canons = new Set(c.members.map(m => canonicalOf[m.playerId] || m.playerId));
    c.linked = canons.size === 1;
  }

  // Real duplicates (same person, same season) first, then cross-season.
  clusters.sort((a, b) => (b.sameSeason - a.sameSeason));

  return json({
    clusters,
    clusterCount: clusters.length,
    identity: map,
    scannedTeams,
    scannedPlayers,
    sweptAt: new Date().toISOString(),
  });
};

async function handleAction(req) {
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { action } = body || {};
  try {
    if (action === 'link')     { await setLink(body.fromId, body.toId, body.note); }
    else if (action === 'unlink')   { await removeLink(body.fromId); }
    else if (action === 'separate') { await setSeparate(body.idA, body.idB); }
    else if (action === 'rejoin')   { await removeSeparate(body.idA, body.idB); }
    else return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ error: err.message || 'Action failed' }, 400);
  }
  return json({ ok: true, identity: await getIdentityMap() });
}

function collect(map, field, out) {
  for (const [value, members] of map) {
    // De-dupe: the same playerId can legitimately appear once; we only care
    // when 2+ DISTINCT players share the value.
    const distinctIds = new Set(members.map(m => m.playerId));
    if (distinctIds.size < 2) continue;

    const seasonIds = new Set(members.map(m => m.seasonId));
    out.push({
      field,
      value,
      sameSeason: seasonIds.size === 1,
      members,
    });
  }
}

export const config = { path: '/.netlify/functions/admin-duplicates' };
