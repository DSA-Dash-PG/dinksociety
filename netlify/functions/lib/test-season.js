// netlify/functions/lib/test-season.js
//
// Shared identity + teardown for the isolated TEST SEASON.
// Used by admin-seed-test-season.js and admin-wipe-test-season.js.
//
// SAFETY: this only ever deletes blobs that belong to the test season —
// keyed under the TEST circuit, the circuit-test season id, or test- id
// prefixes. It can never touch a real season's data.

import { getStore } from '@netlify/blobs';

export const TEST = {
  SEASON_ID: 'circuit-test',
  CIRCUIT:   'TEST',
  DIVISION:  'test-mixed',
  TEAM_PREFIX: 'team-test-',
};

async function deleteByPrefix(storeName, prefix) {
  const store = getStore(storeName);
  const { blobs } = await store.list({ prefix });
  await Promise.all(blobs.map(({ key }) => store.delete(key).catch(() => null)));
  return blobs.length;
}

async function deleteKey(storeName, key) {
  const store = getStore(storeName);
  const existed = await store.get(key).catch(() => null);
  await store.delete(key).catch(() => null);
  return existed ? 1 : 0;
}

/**
 * Remove every trace of the test season. Returns per-store deletion counts.
 * Safe to call when nothing has been seeded yet (all counts 0).
 */
export async function wipeTestSeason() {
  const deleted = {};

  // Season record
  deleted.seasons = await deleteKey('seasons', TEST.SEASON_ID);

  // Teams: only those flagged isTest (defensive — also matches id prefix)
  const teamStore = getStore('teams');
  const { blobs: teamBlobs } = await teamStore.list({ prefix: 'team/' });
  let teamCount = 0;
  await Promise.all(teamBlobs.map(async ({ key }) => {
    const t = await teamStore.get(key, { type: 'json' }).catch(() => null);
    if (t && (t.isTest === true || (t.id || '').startsWith(TEST.TEAM_PREFIX) || t.seasonId === TEST.SEASON_ID)) {
      await teamStore.delete(key).catch(() => null);
      teamCount++;
    }
  }));
  deleted.teams = teamCount;

  // Schedule weeks: schedule/TEST/...
  deleted.schedule = await deleteByPrefix('schedule', `schedule/${TEST.CIRCUIT}/`);

  // Scores + lineups: keyed by matchId, which starts with m_TEST_
  deleted.scores  = await deleteByPrefix('scores',  `score/m_${TEST.CIRCUIT}_`);
  deleted.lineups = await deleteByPrefix('lineups', `lineup/m_${TEST.CIRCUIT}_`);

  // Aggregates
  deleted.standings    = await deleteKey('standings',    `standings/${TEST.CIRCUIT}.json`);
  deleted.playerStats  = await deleteKey('player-stats', `player-stats/${TEST.CIRCUIT}.json`);

  return deleted;
}
