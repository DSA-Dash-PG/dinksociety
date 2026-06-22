// netlify/functions/lib/demo-data.js
//
// Shared identity + teardown for the DEMO season seeded by seed-demo-data.js.
//
// SAFETY: wipeDemoData() only ever deletes records that belong to the demo
// season — matched by the stable demo seasonId, the isTest marker, or the
// demo key/id prefixes. It can never touch a real season's data.
//
// The demo season uses its own ids (circuit-demo / DEMO / demo-* divisions /
// team-demo-* teams) precisely so it never collides with the real Circuit I
// (circuit-i) or the QA test season (circuit-test).

import { getStore } from '@netlify/blobs';

export const DEMO = {
  SEASON_ID: 'circuit-demo',
  CIRCUIT: 'DEMO',
  TEAM_PREFIX: 'team-demo-',
  // Demo divisions are namespaced so they never shadow real division ids.
  DIVISIONS: [
    { id: 'demo-3-0-mixed', name: '3.0 Mixed (Demo)', short: '30' },
    { id: 'demo-3-5-mixed', name: '3.5 Mixed (Demo)', short: '35' },
  ],
};

export function isDemoSeasonId(id) {
  return String(id || '').toLowerCase() === DEMO.SEASON_ID;
}

async function deleteKey(store, key) {
  const existed = await store.get(key).catch(() => null);
  await store.delete(key).catch(() => null);
  return existed ? 1 : 0;
}

// List a whole store and delete only the blobs the predicate approves.
// pred(value, key) — value is parsed JSON (or null if unparseable).
async function deleteWhere(storeName, pred) {
  const store = getStore(storeName);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  let n = 0;
  await Promise.all(blobs.map(async ({ key }) => {
    const v = await store.get(key, { type: 'json' }).catch(() => null);
    if (pred(v, key)) { await store.delete(key).catch(() => null); n++; }
  }));
  return n;
}

/**
 * Remove every trace of the demo season. Returns per-store deletion counts.
 * Safe to call when nothing has been seeded yet (all counts 0).
 *
 * Each predicate is scoped to the demo identity so a real season can never be
 * caught: matches require the demo seasonId, the isTest flag, or a demo key
 * prefix — never a blanket "delete everything in this store".
 */
export async function wipeDemoData() {
  const deleted = {};

  // seasons — only the single demo season key.
  deleted.seasons = await deleteKey(getStore('seasons'), DEMO.SEASON_ID);

  // teams — demo teams are flat-keyed `team-demo-…` with seasonId circuit-demo.
  deleted.teams = await deleteWhere('teams', (v, k) =>
    String(k).startsWith(DEMO.TEAM_PREFIX) ||
    (v && (v.seasonId === DEMO.SEASON_ID || (v.isTest === true && String(v.id || '').startsWith(DEMO.TEAM_PREFIX)))));

  // matches — only the demo seeder writes this store; scope to demo anyway.
  deleted.matches = await deleteWhere('matches', (v, k) =>
    String(k).startsWith('match-demo-') ||
    (v && (v.seasonId === DEMO.SEASON_ID || (v.isTest === true && v.circuit === DEMO.CIRCUIT))));

  // standings — demo writes old per-division blobs keyed `circuit-demo:<div>`.
  deleted.standings = await deleteWhere('standings', (v, k) =>
    String(k).startsWith(`${DEMO.SEASON_ID}:`) ||
    (v && v.seasonId === DEMO.SEASON_ID && v.isTest === true));

  // leaderboard — only the demo seeder writes this store.
  deleted.leaderboard = await deleteWhere('leaderboard', (v, k) =>
    String(k).startsWith('lb-demo-') ||
    (v && (v.seasonId === DEMO.SEASON_ID || v.isTest === true)));

  // registrations — real regs live under confirmed/ pending/ rejected/ prefixes
  // and are never isTest; demo regs are flat `reg-demo-…` and isTest+demo season.
  deleted.registrations = await deleteWhere('registrations', (v, k) =>
    String(k).startsWith('reg-demo-') ||
    (v && v.seasonId === DEMO.SEASON_ID && v.isTest === true));

  return deleted;
}
