// tests/traffic-e2e.test.js — beacon → presence → day rows, against an in-memory blob store.
// Needs --experimental-test-module-mocks (npm run test:all).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
const data = new Map(); let n=0;
const store = {
  async get(k){ const v=data.get(k); return v? JSON.parse(v.body):null; },
  async setJSON(k,v){ data.set(k,{body:JSON.stringify(v),etag:'e'+(++n)}); },
  async delete(k){ data.delete(k); },
  async list({prefix}){ return { blobs:[...data.keys()].filter(k=>k.startsWith(prefix)).map(k=>({key:k,etag:data.get(k).etag})) }; },
};
// Module mocking is flag-gated; skip the file instead of failing without it.
let T = null, skip = false;
try {
  mock.module('@netlify/blobs', { namedExports: { getStore: () => store } });
  T = await import('../netlify/functions/lib/traffic.js');
} catch {
  skip = 'needs --experimental-test-module-mocks';
}
const req = (ua='Mozilla/5.0 (iPhone) Safari') => new Request('https://x/', { method:'POST', headers:{'user-agent':ua} });
test('beacon → live → report', { skip }, async () => {
  const st = Date.now()-120e3;
  const b = { vid:'vvvvvvvvvv1', sid:'ssssssssss1', pvid:'pppppppppp1', st, path:'/schedule.html', title:'Schedule · The Dink Society', q:{token:'x'} };
  await T.recordHit({ ...b, k:'start', ms:0 }, req(), { geo:{ city:'Torrance', subdivision:{code:'CA'} } });
  await T.recordHit({ ...b, k:'hb', ms:30000, sc:40 }, req(), {});
  await T.recordHit({ ...b, k:'hb', ms:20000, sc:10 }, req(), {}); // late/out-of-order: must not regress
  let live = await T.loadLive(store, new Map());
  assert.equal(live.active.length, 1);
  assert.equal(live.active[0].path, '/schedule');
  assert.equal(live.active[0].city, 'Torrance');
  const b2 = { ...b, pvid:'pppppppppp2', st: Date.now()-30e3, path:'/standings.html', title:'Standings' };
  await T.recordHit({ ...b2, k:'start', ms:0 }, req(), {});
  await T.recordHit({ ...b, k:'end', ms:31000 }, req(), {}); // old page end after new start
  live = await T.loadLive(store, new Map());
  assert.equal(live.active.length, 1);
  assert.equal(live.active[0].path, '/standings');
  assert.equal(live.active[0].pages, 2);
  await T.recordHit({ ...b2, k:'hide', ms:5000 }, req(), {});
  live = await T.loadLive(store, new Map());
  assert.equal(live.active.length, 0); assert.equal(live.recent.length, 1);
  await T.recordHit({ ...b, pvid:'botbotbot1', k:'start' }, req('Googlebot'), {});
  const rows = await T.loadDayRows(store, T.pacificDay());
  assert.equal(rows.length, 2);
  const again = await T.loadDayRows(store, T.pacificDay());
  assert.equal(again.length, 2);
  const R = T.buildReport(rows, {});
  assert.equal(R.kpis.sessions, 1);
  assert.equal(R.kpis.totalMs, 36000);
  assert.equal(R.pages.find(p=>p.s==='/schedule').avgScroll, 40);
  assert.ok(!JSON.stringify([...data.values()]).includes('token'));
  assert.ok([...data.keys()].some(k=>k.startsWith('activity-log')||k.startsWith('pageview/')));
});
