// netlify/functions/public-ladder-avatars.js
// GET /api/public-ladder-avatars?ids=<ladderId>,<ladderId>,…
//   → { photos: { <ladderId>: "/.netlify/functions/player-photo-serve?id=…&v=…" } }
//
// Profile pictures for a list of LADDER player ids, in one call. Only APPROVED
// photos are ever returned (that's all player-photo-serve will stream anyway),
// and an id with no photo is simply absent — the page draws initials instead.
//
// Resolution, cheapest first:
//   1. The ladder id IS the photo owner. A player who registered herself uses
//      her league roster id or her lite `lp_…` id on every signup, and photos
//      are keyed by that same id — so most rows resolve with zero extra reads.
//   2. Otherwise the ladder id is a manual roster add (a synthetic id), so go
//      by email: master directory → lite email pointer → team rosters. Teams
//      are only scanned when something is still unresolved after the first two.
//
// Public, no auth. Photos change rarely, so this caches for a while.

import { getStore } from '@netlify/blobs';
import { getDirectory } from './lib/player-directory.js';
import { getLiteByEmail } from './lib/ladder-players.js';
import { normalizeEmail } from './lib/identity.js';
import { etagJson } from './lib/http-cache.js';

const CACHE = 'public, max-age=300, stale-while-revalidate=3600';
const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_IDS = 200;

const photoUrl = (pid, v) =>
  '/.netlify/functions/player-photo-serve?id=' + encodeURIComponent(pid) + (v ? '&v=' + encodeURIComponent(v) : '');

/** Every playerId with an approved photo → its metadata (for cache-busting). */
async function approvedPhotos() {
  const out = new Map();
  try {
    const { blobs } = await getStore('player-photos').list({ prefix: 'img/' });
    for (const b of blobs || []) {
      const pid = b.key.slice(4);
      if (pid) out.set(pid, b.etag || '');
    }
  } catch { /* store not provisioned yet → nobody has a photo */ }
  return out;
}

/** email → league roster id, built lazily from every team blob. */
async function teamIdsByEmail() {
  const map = new Map();
  try {
    const store = getStore('teams');
    const { blobs } = await store.list({ prefix: 'team/' });
    const teams = await Promise.all((blobs || []).map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
    for (const team of teams) {
      for (const p of team?.roster || []) {
        const norm = p.normalizedEmail || normalizeEmail(p.email || '');
        if (norm && p.id && !map.has(norm)) map.set(norm, p.id);
      }
    }
  } catch { /* leave empty */ }
  return map;
}

export default async (req) => {
  const raw = new URL(req.url).searchParams.get('ids') || '';
  const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(id => VALID_ID.test(id)))].slice(0, MAX_IDS);
  if (!ids.length) return etagJson(req, { photos: {} }, { cacheControl: CACHE });

  const photos = await approvedPhotos();
  const out = {};
  if (!photos.size) return etagJson(req, { photos: out }, { cacheControl: CACHE });

  // 1. Direct hit.
  const pending = [];
  for (const id of ids) {
    if (photos.has(id)) out[id] = photoUrl(id, photos.get(id));
    else pending.push(id);
  }
  if (!pending.length) return etagJson(req, { photos: out }, { cacheControl: CACHE });

  // 2. By email. The directory is one small blob; lite pointers are one get
  //    per email; teams are scanned once only if still needed.
  const dir = await getDirectory().catch(() => ({}));
  const emailOf = id => normalizeEmail(dir[id]?.email || '');
  const unresolved = [];
  await Promise.all(pending.map(async id => {
    const norm = emailOf(id);
    if (!norm) return;
    const lite = await getLiteByEmail(norm).catch(() => null);
    if (lite?.playerId && photos.has(lite.playerId)) out[id] = photoUrl(lite.playerId, photos.get(lite.playerId));
    else unresolved.push(id);
  }));
  if (unresolved.length) {
    const byEmail = await teamIdsByEmail();
    for (const id of unresolved) {
      const pid = byEmail.get(emailOf(id));
      if (pid && photos.has(pid)) out[id] = photoUrl(pid, photos.get(pid));
    }
  }

  return etagJson(req, { photos: out }, { cacheControl: CACHE });
};

export const config = { path: '/.netlify/functions/public-ladder-avatars' };
