// netlify/functions/lib/player-photo.js
//
// THE ONE PLACE A PLAYER'S PROFILE PICTURE IS DECIDED.
//
// Why: one person holds many ids — a roster entry per season, a lite `lp_` ladder
// account, a synthetic ladder id from the directory — and photos are stored per
// id at player-photos/img/<id>. Every page used to pick "the first id I happen
// to check that has a photo", each in its own order, so the same person showed
// her Season 1 photo on one page, the admin's new upload on another, and
// initials on a third.
//
// Rule: a person's avatar is the MOST RECENTLY APPROVED photo across every id
// she holds. An admin upload (or an admin approving a player/captain upload) is
// always the newest, so whatever the admin sets is what shows everywhere.
//
// Storage (store 'player-photos'):
//   img/<id>         approved binary (unchanged)
//   pending/<id>     awaiting approval (unchanged, never public)
//   uploads.json     { <id>: <ISO approvedAt> }  — written on every approved write
//   index.json       { builtAt, byId: { <anyId>: { src, v } } }  — derived cache
//
// index.json is a pure cache: deleting it is always safe; the next read rebuilds
// it. Anything that changes who-is-who or which photo is live calls
// invalidatePhotoIndex() (uploads, approvals, identity links/splits).

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';
import { getIdentityMap, groupEntries, listRosterEntries } from './league-identity.js';
import { listLitePlayers } from './ladder-players.js';
import { getDirectory } from './player-directory.js';
import { getMergeMap } from './player-merge.js';

const STORE = 'player-photos';
const INDEX_KEY = 'index.json';
const UPLOADS_KEY = 'uploads.json';
// Safety net for changes that don't invalidate (a new roster entry, a directory
// email edit). Explicit invalidation covers photo + identity changes instantly.
const INDEX_TTL_MS = 5 * 60 * 1000;
const MEMO_MS = 30 * 1000;

const SERVE = '/.netlify/functions/player-photo-serve';

function store() { return getStore({ name: STORE, consistency: 'strong' }); }

/** Public URL for a resolved photo. `v` busts every cache when the photo changes. */
export function photoServeUrl(src, v) {
  return SERVE + '?id=' + encodeURIComponent(src) + (v ? '&v=' + encodeURIComponent(v) : '');
}

// ── Write side ──────────────────────────────────────────────────────────────

/**
 * Store an APPROVED photo for `playerId` and make it the person's avatar
 * everywhere. Use this for every approved write (admin upload, approval).
 * @returns {Promise<string>} the approvedAt stamp
 */
export async function putApprovedPhoto(playerId, data, contentType, approvedAt = new Date().toISOString()) {
  const s = store();
  await s.set(`img/${playerId}`, data, { metadata: { contentType: contentType || 'image/jpeg', approvedAt } });
  try {
    const uploads = (await s.get(UPLOADS_KEY, { type: 'json' }).catch(() => null)) || {};
    uploads[playerId] = approvedAt;
    await s.setJSON(UPLOADS_KEY, uploads);
  } catch (e) { console.warn('[player-photo] uploads stamp failed:', e?.message || e); }
  // Rebuild now (one admin request) rather than leaving every avatar request
  // on the next page load to race to rebuild it.
  memo = null;
  try { await getPhotoIndex({ fresh: true }); } catch { await invalidatePhotoIndex(); }
  return approvedAt;
}

/** Drop the derived index so the next read rebuilds it. Never throws. */
export async function invalidatePhotoIndex() {
  memo = null;
  try { await getStore(STORE).delete(INDEX_KEY); } catch { /* ok */ }
}

// ── Read side ───────────────────────────────────────────────────────────────

let memo = null; // { at, index } — per warm function instance

/**
 * The resolved index. Cheap: one blob read (plus a rebuild when stale/missing).
 * @returns {Promise<{ builtAt:string, byId: Object<string,{src:string,v:string}> }>}
 */
export async function getPhotoIndex({ fresh = false } = {}) {
  if (!fresh && memo && Date.now() - memo.at < MEMO_MS) return memo.index;
  let index = fresh ? null : await store().get(INDEX_KEY, { type: 'json' }).catch(() => null);
  if (!index || !index.byId || Date.now() - Date.parse(index.builtAt || 0) > INDEX_TTL_MS) {
    index = await buildPhotoIndex();
    try { await store().setJSON(INDEX_KEY, index); } catch { /* serve anyway */ }
  }
  memo = { at: Date.now(), index };
  return index;
}

/**
 * Resolver bound to the current index: `urlFor(anyId)` → photo URL or null.
 * Pass several ids for one person (roster id, ladder id…) — the first that
 * resolves wins, and they all resolve to the same picture anyway.
 */
export async function photoResolver() {
  let index;
  try { index = await getPhotoIndex(); }
  catch (e) { console.error('[player-photo] index failed:', e?.message || e); index = { byId: {} }; }
  const urlFor = (...ids) => {
    for (const id of ids.flat()) {
      const hit = id && index.byId[id];
      if (hit) return photoServeUrl(hit.src, hit.v);
    }
    return null;
  };
  return { urlFor, sourceFor: (id) => index.byId[id] || null };
}

/** Convenience for single lookups. */
export async function photoUrlFor(...ids) {
  return (await photoResolver()).urlFor(...ids);
}

// ── Build ───────────────────────────────────────────────────────────────────

async function buildPhotoIndex() {
  const s = store();

  // 1. Every id that has an approved photo.
  const has = new Map(); // id → etag
  try {
    const { blobs } = await s.list({ prefix: 'img/' });
    for (const b of blobs || []) { const id = b.key.slice(4); if (id) has.set(id, b.etag || ''); }
  } catch { /* store not provisioned → nobody has a photo */ }
  if (!has.size) return { builtAt: new Date().toISOString(), byId: {} };

  // 2. When each photo was approved. uploads.json is authoritative going
  //    forward; photo stamps on roster entries / lite records cover photos
  //    uploaded before it existed.
  const stamp = new Map();
  const bump = (id, at) => { if (id && at && (!stamp.has(id) || at > stamp.get(id))) stamp.set(id, at); };
  const uploads = (await s.get(UPLOADS_KEY, { type: 'json' }).catch(() => null)) || {};
  for (const [id, at] of Object.entries(uploads)) bump(id, at);

  // 3. Everyone, as identity entries: roster entries, lite ladder accounts,
  //    and directory ids (manual ladder adds carry an email there).
  const [roster, lites, dir, idMap, merges] = await Promise.all([
    listRosterEntriesWithStamps(),
    listLitePlayers().catch(() => []),
    getDirectory().catch(() => ({})),
    getIdentityMap().catch(() => ({ links: {}, splits: {} })),
    getMergeMap().catch(() => ({})),
  ]);
  // Ladder duplicate-id merges ({ fromId: { to } }) are the same kind of
  // "these ids are one person" fact as the league identity links.
  const map = { splits: idMap.splits || {}, links: { ...merges, ...(idMap.links || {}) } };
  const entries = [];
  const seen = new Set();
  const add = (e) => { if (e.id && !seen.has(e.id)) { seen.add(e.id); entries.push(e); } };
  for (const e of roster) { bump(e.id, e.photoAt); add(e); }
  for (const l of lites) {
    bump(l.playerId, l.photo?.updatedAt);
    add({ id: l.playerId, email: l.email, normalizedEmail: l.normalizedEmail || normalizeEmail(l.email) });
  }
  for (const [id, info] of Object.entries(dir)) {
    const em = normalizeEmail(info?.email || '');
    if (em) add({ id, email: em, normalizedEmail: em });
  }
  // Photos under an id nobody knows about still serve as themselves.
  for (const id of has.keys()) add({ id });

  const { membersOf } = groupEntries(entries, map);

  // 4. Per person: the newest approved photo wins. Photos with no stamp at all
  //    (very old uploads) lose to any stamped one.
  const byId = {};
  for (const ids of Object.values(membersOf)) {
    let best = null;
    for (const id of ids) {
      if (!has.has(id)) continue;
      const at = stamp.get(id) || '';
      if (!best || at > best.at || (at === best.at && id > best.id)) best = { id, at };
    }
    if (!best) continue;
    const v = best.at || has.get(best.id) || '';
    for (const id of ids) byId[id] = { src: best.id, v };
  }
  return { builtAt: new Date().toISOString(), byId };
}

async function listRosterEntriesWithStamps() {
  // listRosterEntries() flattens teams but drops the photo stamp; read it here.
  try {
    const teams = getStore('teams');
    const { blobs } = await teams.list({ prefix: 'team/' });
    const loaded = await Promise.all((blobs || []).map(b => teams.get(b.key, { type: 'json' }).catch(() => null)));
    const out = [];
    for (const team of loaded) {
      for (const p of team?.roster || []) {
        if (!p?.id) continue;
        out.push({
          id: p.id, name: p.name || null, email: p.email || null,
          normalizedEmail: p.normalizedEmail || normalizeEmail(p.email),
          teamId: team.id, seasonId: team.seasonId || null, circuit: team.circuit || null,
          photoAt: p.photo?.updatedAt || null,
        });
      }
    }
    return out;
  } catch {
    return (await listRosterEntries().catch(() => [])).map(e => ({ ...e, photoAt: null }));
  }
}
