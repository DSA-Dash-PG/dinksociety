// tests/public-player-identity.test.js
//
// One human, several roster ids: does /public-player return her whole record?
//
// These exercise the real endpoint against an in-memory stand-in for Netlify
// Blobs, so they need Node's module mocking:
//
//   node --test --experimental-test-module-mocks tests/
//
// Without that flag the file skips itself rather than failing the suite.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';


// ── In-memory stand-in for Netlify Blobs ───────────────────────────
const DB = {
  teams: {
    'team/t_old.json': { id:'t_old', name:'Old Squad', seasonId:'circuit-i', circuit:'I',
      roster:[ {id:'p_old_0', name:'Jane Doe', email:'Jane@Example.com', phone:'555-111-2222'},
               {id:'p_old_1', name:'Bob Ross',  email:'bob@example.com'} ] },
    'team/t_new.json': { id:'t_new', name:'Jane\'s Team', seasonId:'circuit-2', circuit:'II',
      roster:[ {id:'p_new_0', name:'Jane Doe', email:'jane@example.com', phone:'5551112222'},
               {id:'p_new_1', name:'Cara Lee', email:'cara@example.com'} ] },
  },
  'player-stats': {
    'player-stats/I.json': { players: {
      p_old_0: { playerId:'p_old_0', name:'Jane Doe', teamId:'t_old', teamName:'Old Squad',
                 gamesPlayed:20, gamesWon:14, gamesLost:6, matchesPlayed:8, ps:400, pa:330, diff:70,
                 composite:512.5, byType:{ mixed:{won:9,lost:4} }, partners:{ p_old_1:{played:6,won:4} }, awards:['potw'] },
      p_old_1: { playerId:'p_old_1', name:'Bob Ross', teamId:'t_old', teamName:'Old Squad' },
    } },
    'player-stats/II.json': { players: {
      p_new_0: { playerId:'p_new_0', name:'Jane Doe', teamId:'t_new', teamName:"Jane's Team",
                 gamesPlayed:8, gamesWon:5, gamesLost:3, matchesPlayed:4, ps:150, pa:130, diff:20,
                 composite:530, byType:{ mixed:{won:3,lost:2}, womens:{won:2,lost:1} }, partners:{ p_new_1:{played:3,won:2} } },
      p_new_1: { playerId:'p_new_1', name:'Cara Lee', teamId:'t_new', teamName:"Jane's Team" },
    } },
    'player-stats/TEST.json': { players: { p_old_0: { playerId:'p_old_0', name:'Jane Doe', teamId:'t_qa', teamName:'QA', gamesWon:99 } } },
  },
  'player-history': {},          // Season 1 was never finalized — the fallback must cover it
  'league-identity': {},
};

function store(name) {
  const bag = DB[name] || (DB[name] = {});
  return {
    async get(key, opts) { const v = bag[key]; if (v === undefined) return null; return opts?.type === 'json' ? structuredClone(v) : JSON.stringify(v); },
    async setJSON(key, val) { bag[key] = structuredClone(val); },
    async list(opts) { const p = opts?.prefix || ''; return { blobs: Object.keys(bag).filter(k => k.startsWith(p)).map(key => ({ key })) }; },
    async delete(key) { delete bag[key]; },
  };
}
// Module mocking is flag-gated; skip the file instead of failing without it.
let handler = null;
let skip = false;
try {
  mock.module('@netlify/blobs', { namedExports: { getStore: (arg) => store(typeof arg === 'string' ? arg : arg.name) } });
  ({ default: handler } = await import('../netlify/functions/public-player.js'));
} catch {
  skip = 'needs --experimental-test-module-mocks';
}

const call = async (qs) => {
  const res = await handler(new Request('https://x/.netlify/functions/public-player?' + qs, { method:'GET' }));
  return res.json();
};

test('her new roster id returns the merged person, not a blank slate', { skip }, async () => {
  const d = await call('id=p_new_0&circuit=II');
  assert.deepEqual(d.identity.ids.sort(), ['p_new_0','p_old_0'], 'both of her ids resolve to one person');
  assert.equal(d.identity.merged, true);
  // Current season stats stay her new team's — she has one id in Season 2.
  assert.equal(d.player.teamName, "Jane's Team");
  assert.equal(d.player.gamesWon, 5);
  // ...and Season 1 shows up in history even though it was never finalized.
  const s1 = d.history.find(s => s.circuit === 'I');
  assert.ok(s1, 'Season 1 is present in her history');
  assert.equal(s1.teamName, 'Old Squad');
  assert.equal(s1.stats.gamesWon, 14);
  assert.equal(s1.seasonLabel, 'Season 1');
  assert.equal(s1.provisional, true, 'flagged as not-yet-finalized');
  assert.ok(!d.history.some(s => String(s.circuit).toUpperCase() === 'TEST'), 'the QA season never appears');
});

test('a teammate with a different email is untouched', { skip }, async () => {
  const d = await call('id=p_new_1&circuit=II');
  assert.deepEqual(d.identity.ids, ['p_new_1']);
  assert.equal(d.identity.merged, false);
  assert.equal(d.history.length, 0);
});

test('an admin split un-merges two people sharing an inbox', { skip }, async () => {
  DB['league-identity']['map.json'] = { links:{}, splits:{ 'p_new_0|p_old_0': true } };
  const d = await call('id=p_new_0&circuit=II');
  assert.deepEqual(d.identity.ids, ['p_new_0']);
  assert.equal(d.history.length, 0, 'Season 1 no longer follows her');
  delete DB['league-identity']['map.json'];
});

test('an admin link joins ids that share no email', { skip }, async () => {
  DB.teams['team/t_new.json'].roster[0].email = 'jane.jones@example.com'; // married name, new inbox
  let d = await call('id=p_new_0&circuit=II');
  assert.deepEqual(d.identity.ids, ['p_new_0'], 'no longer auto-linked');
  DB['league-identity']['map.json'] = { links: { p_old_0: { to: 'p_new_0' } }, splits: {} };
  d = await call('id=p_new_0&circuit=II');
  assert.deepEqual(d.identity.ids.sort(), ['p_new_0','p_old_0']);
  assert.ok(d.history.some(s => s.circuit === 'I'), 'her old season is back');
  DB.teams['team/t_new.json'].roster[0].email = 'jane@example.com';
  delete DB['league-identity']['map.json'];
});

test('two teams in ONE season: counting stats add, DSR is not summed', { skip }, async () => {
  DB['player-stats']['player-stats/II.json'].players.p_old_0 = {
    playerId:'p_old_0', name:'Jane Doe', teamId:'t_old', teamName:'Old Squad',
    gamesPlayed:4, gamesWon:1, gamesLost:3, matchesPlayed:2, ps:60, pa:80, diff:-20,
    composite:400, byType:{ mixed:{won:1,lost:3} }, partners:{ p_old_1:{played:2,won:1} },
  };
  const d = await call('id=p_new_0&circuit=II');
  assert.equal(d.player.gamesWon, 6, '5 + 1');
  assert.equal(d.player.gamesLost, 6, '3 + 3');
  assert.equal(d.player.ps, 210);
  assert.equal(d.player.diff, 0, 'recomputed from merged ps/pa');
  assert.equal(d.player.composite, 530, 'DSR from the entry she played most, never a sum');
  assert.equal(d.player.teamName, "Jane's Team", 'the team she was looked up under');
  assert.equal(d.player.teams.length, 2, 'both teams listed');
  assert.deepEqual(Object.keys(d.player.partners).sort(), ['p_new_1','p_old_1']);
  delete DB['player-stats']['player-stats/II.json'].players.p_old_0;
});

test('a finalized history blob is not duplicated by the fallback', { skip }, async () => {
  DB['player-history']['p_old_0.json'] = { playerId:'p_old_0', name:'Jane Doe', seasons:[
    { circuit:'I', seasonLabel:'Season 1', year:2026, teamId:'t_old', teamName:'Old Squad',
      stats:{ gamesPlayed:20, gamesWon:14, gamesLost:6, matchesPlayed:8 } },
  ] };
  const d = await call('id=p_new_0&circuit=II');
  const s1 = d.history.filter(s => s.circuit === 'I');
  assert.equal(s1.length, 1, 'exactly one Season 1 row');
  assert.ok(!s1[0].provisional, 'the finalized row wins');
  delete DB['player-history']['p_old_0.json'];
});
