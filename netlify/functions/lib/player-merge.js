// netlify/functions/lib/player-merge.js
//
// The app has no global player table — a player is an ID embedded in each ladder's
// play data. The Pickleladder import created separate IDs for the same human across
// old leagues (e.g. two "Rich"). A MERGE maps a duplicate ID onto a canonical ID so
// every consumer (leaderboard, XP, profile) treats them as one person.
//
//   ladder-merges  map.json → { [fromId]: { to, name } }
//
// applyMerges() rewrites player IDs (and names) in play records in memory, so all
// downstream aggregation (calcStats/calcXP/walk) collapses duplicates automatically.

import { getStore } from '@netlify/blobs';

const STORE = 'ladder-merges';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

export async function getMergeMap() {
  const m = await store().get('map.json', { type: 'json' }).catch(() => null);
  return (m && typeof m === 'object') ? m : {};
}

export async function setMerge(fromId, toId, name) {
  if (!fromId || !toId || fromId === toId) throw new Error('invalid merge');
  const map = await getMergeMap();
  // Prevent a cycle: resolve toId first; it must not resolve back to fromId.
  if (resolve(map, toId) === fromId) throw new Error('would create a loop');
  map[fromId] = { to: toId, name: name || null };
  await store().setJSON('map.json', map);
  return map;
}

export async function removeMerge(fromId) {
  const map = await getMergeMap();
  delete map[fromId];
  await store().setJSON('map.json', map);
  return map;
}

// Follow the alias chain to the canonical id (cycle-guarded).
export function resolve(map, id) {
  let cur = id, seen = new Set();
  while (map[cur] && map[cur].to && !seen.has(cur)) { seen.add(cur); cur = map[cur].to; }
  return cur;
}

// Canonical display name for an id, if a merge specified one along the chain.
export function resolveName(map, id) {
  let cur = id, seen = new Set(), name = null;
  while (map[cur] && map[cur].to && !seen.has(cur)) { seen.add(cur); name = map[cur].name || name; cur = map[cur].to; }
  return name;
}

// Rewrite player ids/names in play records to their canonical identity.
export function applyMerges(plays, map) {
  if (!map || !Object.keys(map).length) return plays;
  (plays || []).forEach(play => {
    (play.rounds || []).forEach(rd => (rd.courts || []).forEach(c => {
      ['team1', 'team2'].forEach(tk => {
        (c[tk] || []).forEach(p => {
          if (!p) return;
          const canon = resolve(map, p.id);
          if (canon !== p.id) { const nm = resolveName(map, p.id); p.id = canon; if (nm) p.name = nm; }
        });
      });
    }));
  });
  return plays;
}
