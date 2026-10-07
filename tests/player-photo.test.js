// tests/player-photo.test.js
//
// One avatar per person, site-wide (netlify/functions/lib/player-photo.js).
// Runs against an in-memory stand-in for Netlify Blobs, so it needs:
//
//   node --test --experimental-test-module-mocks tests/
//
// Without that flag these tests skip themselves rather than failing the suite.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const DB = {};
function store(name) {
  const bag = DB[name] || (DB[name] = {});
  return {
    async get(key, opts) { const v = bag[key]; if (v === undefined) return null; return opts?.type === 'json' ? structuredClone(v.data ?? v) : v; },
    async getWithMetadata(key) { const v = bag[key]; return v === undefined ? null : { data: v.data, metadata: v.metadata || {} }; },
    async set(key, data, opts) { bag[key] = { data, metadata: opts?.metadata || {}, etag: 'e' + Math.random().toString(36).slice(2, 7) }; },
    async setJSON(key, val) { bag[key] = structuredClone(val); },
    async list(opts) { const p = opts?.prefix || ''; return { blobs: Object.keys(bag).filter(k => k.startsWith(p)).map(key => ({ key, etag: bag[key]?.etag || '' })) }; },
    async delete(key) { delete bag[key]; },
  };
}
const reset = () => { for (const k of Object.keys(DB)) delete DB[k]; };

let P = null;
try {
  mock.module('@netlify/blobs', { namedExports: { getStore: (arg) => store(typeof arg === 'string' ? arg : arg.name) } });
  P = await import('../netlify/functions/lib/player-photo.js');
} catch { P = null; }
const t = (name, fn) => test(name, { skip: !P && 'needs --experimental-test-module-mocks' }, fn);

function seedTeams() {
  const teams = store('teams');
  // Angel: Season 1 on Big Dink Energy, Season 2 on another team, same email.
  return Promise.all([
    teams.setJSON('team/bde.json', { id: 'bde', name: 'Big Dink Energy', circuit: 'I', roster: [
      { id: 'p_s1_angel', name: 'Angel Munar', email: 'Angel@Example.com', photo: { updatedAt: '2026-05-01T00:00:00.000Z' } },
    ] }),
    teams.setJSON('team/hhh.json', { id: 'hhh', name: 'Happy Hour Hitters', circuit: 'II', roster: [
      { id: 'p_s2_angel', name: 'Angel Munar', email: 'angel@example.com' },
      { id: 'p_s2_bob', name: 'Bob', email: 'bob@example.com' },
    ] }),
  ]);
}

t('every id of a person resolves to the SAME photo — the newest approved one', async () => {
  reset(); await seedTeams();
  const ph = store('player-photos');
  // Old Season 1 photo (stamped on the S1 roster entry only).
  await ph.set('img/p_s1_angel', 'OLD', { metadata: { contentType: 'image/jpeg' } });
  // Admin uploads a new one against her Season 2 entry.
  await P.putApprovedPhoto('p_s2_angel', 'NEW', 'image/jpeg', '2026-10-07T16:00:00.000Z');

  const { urlFor, sourceFor } = await P.photoResolver();
  assert.equal(sourceFor('p_s1_angel').src, 'p_s2_angel');
  assert.equal(sourceFor('p_s2_angel').src, 'p_s2_angel');
  assert.equal(urlFor('p_s1_angel'), urlFor('p_s2_angel'));
  assert.match(urlFor('p_s1_angel'), /id=p_s2_angel&v=2026-10-07/);
  assert.equal(urlFor('p_s2_bob'), null, 'no photo → null (initials)');
});

t('a later upload under an OLD id still wins (newest, not newest season)', async () => {
  reset(); await seedTeams();
  await P.putApprovedPhoto('p_s2_angel', 'A', 'image/jpeg', '2026-09-01T00:00:00.000Z');
  await P.putApprovedPhoto('p_s1_angel', 'B', 'image/jpeg', '2026-10-01T00:00:00.000Z');
  const { sourceFor } = await P.photoResolver();
  assert.equal(sourceFor('p_s2_angel').src, 'p_s1_angel');
});

t('ladder-only (lite) and directory ids join the same person by email', async () => {
  reset(); await seedTeams();
  await store('ladder-players').setJSON('player/lp_angel.json', { playerId: 'lp_angel', name: 'Angel', email: 'angel@example.com' });
  await store('ladder-players').setJSON('directory.json', { lad_123: { email: 'ANGEL@example.com' } });
  await P.putApprovedPhoto('p_s2_angel', 'NEW', 'image/jpeg', '2026-10-07T16:00:00.000Z');
  const { urlFor } = await P.photoResolver();
  assert.equal(urlFor('lp_angel'), urlFor('p_s2_angel'));
  assert.equal(urlFor('lad_123'), urlFor('p_s2_angel'));
});

t('admin "not the same person" split keeps two people apart', async () => {
  reset(); await seedTeams();
  await store('league-identity').setJSON('map.json', { links: {}, splits: { 'p_s1_angel|p_s2_angel': true } });
  await P.putApprovedPhoto('p_s1_angel', 'ONE', 'image/jpeg', '2026-05-01T00:00:00.000Z');
  await P.putApprovedPhoto('p_s2_angel', 'TWO', 'image/jpeg', '2026-10-01T00:00:00.000Z');
  const { sourceFor } = await P.photoResolver();
  assert.equal(sourceFor('p_s1_angel').src, 'p_s1_angel');
  assert.equal(sourceFor('p_s2_angel').src, 'p_s2_angel');
});
