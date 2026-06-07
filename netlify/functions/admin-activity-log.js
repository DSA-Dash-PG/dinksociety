// =============================================================
// netlify/functions/admin-activity-log.js
//
// Admin-only read API for the Activity Log + Analytics tabs.
//
// GET                       → recent events (newest first)
//   ?from=YYYY-MM-DD        → events on/after this date
//   ?to=YYYY-MM-DD          → events on/before this date
//   ?team=<teamId>          → events touching this team
//   ?player=<query>         → playerId, or name/email substring (player OR actor)
//   ?type=<prefix>          → event type prefix ("score", "player.added", "login", ...)
//   ?limit=<n>              → max events returned (default 200, cap 1000)
//
// GET ?view=analytics       → per-person usage + summary stats
//   { stats: { rosteredPlayers, everLoggedIn, activeLast7Days,
//              neverLoggedIn, tabTotals },
//     people: [ { email, name, role, teamId, teamName, lastLoginAt,
//                 loginCount, lastSeenAt, tabs } ],
//     neverLoggedIn: [ { name, email, teamId, teamName } ] }
// =============================================================

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { isTestTeam } from './lib/circuit.js';

const STORE = 'activity-log';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const store = getStore(STORE);

  if (url.searchParams.get('view') === 'analytics') {
    return analytics(store);
  }

  // ── Activity log feed ────────────────────────────────────────
  const from = url.searchParams.get('from'); // YYYY-MM-DD
  const to = url.searchParams.get('to');
  const teamId = url.searchParams.get('team');
  const playerQ = (url.searchParams.get('player') || '').trim().toLowerCase();
  const typeQ = (url.searchParams.get('type') || '').trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 200, 1000);

  const { blobs } = await store.list({ prefix: 'event/' }).catch(() => ({ blobs: [] }));

  // Keys are `event/<ISO>_<rand>.json` → lexicographic order IS time order.
  // Date-filter on the key itself so we never fetch blobs we'll discard.
  let keys = blobs.map(b => b.key).sort(); // ascending time
  if (from) keys = keys.filter(k => k.slice(6, 16) >= from);
  if (to) keys = keys.filter(k => k.slice(6, 16) <= to);

  // Newest first; read at most 5× the limit so team/player/type filters
  // still have material to match against without reading everything.
  keys.reverse();
  const readCap = (teamId || playerQ || typeQ) ? Math.min(keys.length, limit * 5) : Math.min(keys.length, limit);
  const slice = keys.slice(0, readCap);

  const events = (await Promise.all(
    slice.map(k => store.get(k, { type: 'json' }).catch(() => null))
  )).filter(Boolean);

  const filtered = events.filter(e => {
    if (teamId && !matchesTeam(e, teamId)) return false;
    if (typeQ && !(e.type || '').toLowerCase().includes(typeQ)) return false;
    if (playerQ && !matchesPlayer(e, playerQ)) return false;
    return true;
  }).slice(0, limit);

  return json({ events: filtered, total: keys.length, truncated: keys.length > readCap });
};

function matchesTeam(e, teamId) {
  if (e.team?.id === teamId) return true;
  // transfers carry both teams in details meta via team field only; also
  // match on details mention of the id (cheap fallback for from/to teams)
  return false;
}

function matchesPlayer(e, q) {
  const hay = [
    e.player?.id, e.player?.name, e.actor?.email,
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

// ── Analytics ──────────────────────────────────────────────────
async function analytics(store) {
  // 1. Everyone who has ever logged in / been seen
  const { blobs: seenBlobs } = await store.list({ prefix: 'seen/' }).catch(() => ({ blobs: [] }));
  const people = (await Promise.all(
    seenBlobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(Boolean);
  const seenByEmail = new Map(people.map(p => [p.email, p]));

  // 2. Every rostered (non-test) player, to find who's NEVER logged in
  const teamsStore = getStore('teams');
  const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = (await Promise.all(
    teamBlobs.map(b => teamsStore.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(t => t && !isTestTeam(t));

  const rostered = [];
  const seenEmails = new Set(seenByEmail.keys());
  for (const t of teams) {
    for (const p of (t.roster || [])) {
      const email = (p.normalizedEmail || p.email || '').toLowerCase();
      rostered.push({ name: p.name, email: email || null, teamId: t.id, teamName: t.name });
      // enrich seen records with current team if missing
      const seen = email && seenByEmail.get(email);
      if (seen && !seen.teamName) { seen.teamName = t.name; seen.teamId = t.id; }
      if (seen && !seen.name) seen.name = p.name;
    }
  }

  const neverLoggedIn = rostered.filter(p => !p.email || !seenEmails.has(p.email));

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const activeLast7Days = people.filter(p => p.lastSeenAt && new Date(p.lastSeenAt).getTime() > weekAgo).length;
  const activeLast24h = people.filter(p => p.lastSeenAt && new Date(p.lastSeenAt).getTime() > dayAgo).length;

  const tabTotals = {};
  for (const p of people) {
    for (const [tab, n] of Object.entries(p.tabs || {})) {
      tabTotals[tab] = (tabTotals[tab] || 0) + n;
    }
  }

  people.sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));

  return json({
    stats: {
      rosteredPlayers: rostered.length,
      everLoggedIn: people.length,
      activeLast7Days,
      activeLast24h,
      neverLoggedIn: neverLoggedIn.length,
      tabTotals,
    },
    people,
    neverLoggedIn,
  });
}

export const config = { path: '/.netlify/functions/admin-activity-log' };
