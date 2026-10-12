// tests/late-entry.test.js
//
// A replacement team joining mid-season, run end to end against an in-memory
// stand-in for Netlify Blobs: the admin emails an invite, the captain registers
// through it (closed season, $270, confirmed at once so the roster can be built),
// the invite burns, and the second-half redraw puts the new team in the
// departing team's slot — five weeks, three matches a night, no byes, and a
// Championship Night for six that the public schedule still renders.
//
//   node --test --experimental-test-module-mocks tests/late-entry.test.js

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const DB = {};
function store(name) {
  const bag = DB[name] || (DB[name] = {});
  return {
    async get(key, opts) { const v = bag[key]; if (v === undefined) return null; return opts?.type === 'json' ? structuredClone(typeof v === 'string' ? JSON.parse(v) : v) : (typeof v === 'string' ? v : JSON.stringify(v)); },
    async setJSON(key, val) { bag[key] = structuredClone(val); },
    async set(key, val) { bag[key] = val; },
    async list(opts) { const p = opts?.prefix || ''; return { blobs: Object.keys(bag).filter(k => k.startsWith(p)).map(key => ({ key })) }; },
    async delete(key) { delete bag[key]; },
  };
}
const MAIL = [];
class FakeResend { constructor() { this.emails = { send: async (p) => { MAIL.push(p); return { data: { id: 'm' + MAIL.length } }; } }; } }

let skip = false;
let lateEntryFn, checkoutFn, seasonsFn, extendFn, scheduleFn, lookupFn;
try {
  process.env.RESEND_API_KEY = 'test';
  process.env.SITE_URL = 'https://example.test';
  process.env.EMAIL_ADMIN_BCC = 'admin@example.test';
  mock.module('@netlify/blobs', { namedExports: { getStore: (arg) => store(typeof arg === 'string' ? arg : arg.name) } });
  mock.module('resend', { namedExports: { Resend: FakeResend } });
  mock.module(new URL('../netlify/functions/lib/auth.js', import.meta.url).href, { namedExports: {
    verifyAdminSession: async () => ({ valid: true, payload: { email: 'admin@example.test' } }),
    verifyCaptainSession: async () => ({ valid: false }),
    verifyPlayerSession: async () => ({ valid: false }),
    unauthResponse: (e) => new Response(JSON.stringify({ error: e || 'Unauthorized' }), { status: 401 }),
  } });
  ({ default: lateEntryFn } = await import('../netlify/functions/admin-late-entry.js'));
  ({ default: checkoutFn } = await import('../netlify/functions/register-checkout.js'));
  ({ default: seasonsFn } = await import('../netlify/functions/public-seasons.js'));
  ({ default: extendFn } = await import('../netlify/functions/admin-extend-season.js'));
  ({ default: scheduleFn } = await import('../netlify/functions/public-schedule.js'));
  ({ default: lookupFn } = await import('../netlify/functions/registration-lookup.js'));
} catch (e) {
  skip = 'needs --experimental-test-module-mocks (' + (e && e.message ? e.message.slice(0, 160) : e) + ')';
}

const DIV = '3.5 Mix';
const NAMES = ['Dink or Swim', 'Smash Society', 'Bonkerz', 'Happy Hour Hitters', 'Big Dink Energy', 'FOURPLAY'];
const IDS = NAMES.map((_, i) => `team_t${i + 1}`);
const COURTS = [['5', '6'], ['7', '8'], ['9', '10']];

// Thursday 6:00 PM Pacific (PDT) for week w, Week 1 = Sep 17 2026.
function at(w) { const d = new Date(Date.UTC(2026, 8, 18, 1, 0)); d.setUTCDate(d.getUTCDate() + (w - 1) * 7); return d.toISOString(); }

function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  MAIL.length = 0;
  DB.teams = {};
  NAMES.forEach((n, i) => { DB.teams[`team/${IDS[i]}.json`] = { id: IDS[i], name: n, circuit: 'II', division: DIV, status: 'active', roster: [] }; });
  DB.seasons = { 'circuit-ii': JSON.stringify({
    id: 'circuit-ii', name: 'Season 2', status: 'active', registration: 'closed', startDate: '2026-09-17', weeks: 11,
    divisions: [{ id: DIV, name: '3.5 Mixed', teamPrice: 700, agentPrice: 125 }],
  }) };
  DB.schedule = {};
  // Weeks 1–5: a full single round-robin of six (circle method), all final.
  const seats = [...IDS];
  for (let w = 1; w <= 5; w++) {
    const matches = [];
    for (let i = 0; i < 3; i++) {
      const a = seats[i], b = seats[5 - i];
      matches.push({
        id: `m_II_w${w}_${i + 1}`, teamA: { id: a, name: NAMES[IDS.indexOf(a)] }, teamB: { id: b, name: NAMES[IDS.indexOf(b)] },
        courtA: COURTS[i][0], courtB: COURTS[i][1], court: `Courts ${COURTS[i][0]} & ${COURTS[i][1]}`, venue: 'South End Racquet Club',
        scheduledAt: at(w), scoreA: 2, scoreB: 1, finalizedAt: at(w),
      });
    }
    DB.schedule[`schedule/II/${DIV}/week-${w}.json`] = { circuit: 'II', division: DIV, week: w, matches };
    seats.splice(1, 0, seats.pop());
  }
  // Weeks 6–10 as live today: five teams, a bye each week; Week 11 Championship.
  for (let w = 6; w <= 10; w++) {
    DB.schedule[`schedule/II/${DIV}/week-${w}.json`] = {
      circuit: 'II', division: DIV, week: w, format: 'double', extendedFrom: 'draw',
      matches: [{ id: `m_old_w${w}`, teamA: { id: IDS[0], name: NAMES[0] }, teamB: { id: IDS[1], name: NAMES[1] }, scheduledAt: at(w) }],
      byes: [{ id: IDS[w % 5], name: NAMES[w % 5] }], withdrawn: [{ id: IDS[5], name: 'FOURPLAY' }],
    };
  }
}

const post = (fn, url, body) => fn(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
const get = (fn, url) => fn(new Request(url));

test('invite → register → redraw: the replacement plays every week of the second half', { skip }, async () => {
  seed();

  // 1. Admin emails the invite.
  let r = await post(lateEntryFn, 'https://x/.netlify/functions/admin-late-entry', {
    circuit: 'II', name: 'Jane Smith', email: 'Jane@Example.com', replaces: 'FOURPLAY', price: 270, startWeek: 6,
  });
  let d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.sent, true);
  assert.equal(d.lateEntry.division, DIV);
  assert.equal(d.lateEntry.price, 270);
  assert.deepEqual(d.lateEntry.replaces, { id: IDS[5], name: 'FOURPLAY' });
  const code = new URL(d.url).searchParams.get('invite');
  assert.ok(code && code.length >= 8);
  const invite = MAIL.find(m => (Array.isArray(m.to) ? m.to[0] : m.to) === 'jane@example.com');
  assert.ok(invite, 'invite email sent');
  assert.match(invite.html, /\$270/);
  assert.ok(invite.html.includes(d.url.replace(/&/g, '&amp;')));

  // 2. The public page only learns about it with the code.
  d = await (await get(seasonsFn, 'https://x/.netlify/functions/public-seasons')).json();
  assert.equal(d.seasons[0].lateEntry, undefined);
  d = await (await get(seasonsFn, `https://x/.netlify/functions/public-seasons?invite=${code}`)).json();
  const le = d.seasons[0].lateEntry;
  assert.equal(le.price, 270);
  assert.equal(le.startWeek, 6);
  assert.equal(le.used, false);
  assert.ok(le.weeks.length >= 5);
  assert.equal(JSON.stringify(d).includes(code), false, 'the code itself is never echoed back');

  // 3. She registers while season registration is closed.
  const team = { name: 'Net Results', captain: 'Jane Smith', players: [{ name: 'Jane Smith', email: 'jane@example.com', captain: true }] };
  r = await post(checkoutFn, 'https://x/.netlify/functions/register-checkout', {
    seasonId: 'circuit-ii', circuit: 'II', division: 'anything', path: 'team', price: 1, paymentMethod: 'venmo', invite: code, team,
  });
  d = await r.json();
  assert.equal(r.status, 200);
  const regId = new URL(d.confirmationUrl).searchParams.get('id');
  const reg = JSON.parse(DB.registrations[`confirmed/${regId}.json`]);
  assert.equal(reg.status, 'confirmed');
  assert.equal(reg.totalPrice, 270, 'price comes from the invite, not the page');
  assert.equal(reg.division, DIV, 'division comes from the invite');
  assert.equal(reg.paymentType, 'full');
  const newTeam = DB.teams[`team/team_${regId}.json`];
  assert.ok(newTeam, 'team record exists — Captain Portal login works now');
  assert.equal(newTeam.captainEmail, 'jane@example.com');
  assert.ok(MAIL.some(m => /build your Net Results roster/.test(m.subject)), 'roster email');
  assert.equal(MAIL.some(m => /registration confirmed/.test(m.subject)), false, 'no "Venmo received" email');
  const lk = await (await get(lookupFn, `https://x/.netlify/functions/registration-lookup?id=${regId}`)).json();
  assert.equal(lk.registration.venmo.amount, 270);
  assert.ok(lk.registration.lateEntry);

  // The invite is burned.
  r = await post(checkoutFn, 'https://x/.netlify/functions/register-checkout', {
    seasonId: 'circuit-ii', division: DIV, path: 'team', invite: code, team: { ...team, name: 'Again' },
  });
  assert.equal(r.status, 409);

  // 4. Redraw: dry run, then the same draw for real.
  r = await post(extendFn, 'https://x/.netlify/functions/admin-extend-season', {
    circuit: 'II', withdrawn: [IDS[5]], replacement: newTeam.id, dryRun: true,
  });
  d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.replacement.name, 'Net Results');
  const dry = d.plan;
  r = await post(extendFn, 'https://x/.netlify/functions/admin-extend-season', {
    circuit: 'II', withdrawn: [IDS[5]], replacement: newTeam.id, seed: d.seed, dryRun: false,
  });
  d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.deepEqual(d.plan, dry, 'live run writes the previewed draw');

  const met = new Set();
  const plays = {};
  for (let w = 6; w <= 10; w++) {
    const wk = DB.schedule[`schedule/II/${DIV}/week-${w}.json`];
    assert.equal(wk.matches.length, 3, `week ${w}: three matches`);
    assert.equal(wk.byes, undefined, `week ${w}: no byes`);
    const la = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const want = new Date(Date.UTC(2026, 8, 17 + (w - 1) * 7, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
    assert.equal(la(wk.matches[0].scheduledAt), `${want}, 6:00 PM`, `week ${w}: Thursday 6:00 PM Pacific`);
    assert.equal(new Set(wk.matches.map(m => m.courtA)).size, 3, `week ${w}: three different courts`);
    for (const m of wk.matches) {
      assert.notEqual(m.teamA.id, IDS[5]); assert.notEqual(m.teamB.id, IDS[5]);
      met.add([m.teamA.id, m.teamB.id].sort().join('|'));
      plays[m.teamA.id] = (plays[m.teamA.id] || 0) + 1;
      plays[m.teamB.id] = (plays[m.teamB.id] || 0) + 1;
    }
  }
  assert.equal(met.size, 15, 'every pair of the six meets once');
  assert.equal(plays[newTeam.id], 5);
  for (const id of IDS.slice(0, 5)) assert.equal(plays[id], 5);

  const champ = DB.schedule[`schedule/II/${DIV}/week-11.json`];
  assert.equal(champ.matches.length, 3, 'Championship Night for six: 1v2, 3v4, 5v6');
  assert.deepEqual(champ.matches.map(m => m.seedA.rank), [1, 3, 5]);
  assert.ok(champ.matches.every(m => (m.withdrawn || []).includes(IDS[5])), 'FOURPLAY never seeded');

  // 5. The public schedule still renders the bracket with 7 names / 6 seats.
  d = await (await get(scheduleFn, 'https://x/.netlify/functions/public-schedule?season=circuit-ii')).json();
  const wk11 = d.weeks.find(w => w.week === 11);
  assert.ok(wk11 && wk11.matches.length === 3, 'Championship Night still on the public schedule');
  assert.ok(d.weeks.filter(w => w.week >= 6 && w.week <= 10).every(w => !w.byes));
});

test('a replacement needs a withdrawn team, and an unknown team is refused', { skip }, async () => {
  seed();
  DB.teams['team/team_new.json'] = { id: 'team_new', name: 'Net Results', circuit: 'II', division: DIV, status: 'active' };
  let r = await post(extendFn, 'https://x/.netlify/functions/admin-extend-season', { circuit: 'II', replacement: 'team_new', dryRun: true });
  assert.equal(r.status, 409);
  r = await post(extendFn, 'https://x/.netlify/functions/admin-extend-season', { circuit: 'II', withdrawn: ['FOURPLAY'], replacement: 'Nobody', dryRun: true });
  assert.equal(r.status, 400);
});
