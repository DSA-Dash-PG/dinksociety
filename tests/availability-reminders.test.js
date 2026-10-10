// tests/availability-reminders.test.js
//
// The automatic "are you in?" reminders, run for real against an in-memory
// stand-in for Netlify Blobs and a fake mail client. Two things broke them for
// Season 2 and are pinned here: the job was hardcoded to Season 1, and it only
// looked at a roster entry's own `email`, which many Season 2 entries lack.
//
//   node --test --experimental-test-module-mocks tests/availability-reminders.test.js
//
// Without that flag these tests skip themselves rather than failing the suite.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { seasonMatches, teamsById } from './fixtures/night-recap-week4.js';

const DB = {};
function store(name) {
  const bag = DB[name] || (DB[name] = {});
  return {
    async get(key, opts) { const v = bag[key]; if (v === undefined) return null; return opts?.type === 'json' ? structuredClone(v) : JSON.stringify(v); },
    async setJSON(key, val) { bag[key] = structuredClone(val); },
    async set(key, val) { bag[key] = val; },
    async list(opts) { const p = opts?.prefix || ''; return { blobs: Object.keys(bag).filter(k => k.startsWith(p)).map(key => ({ key })) }; },
    async delete(key) { delete bag[key]; },
  };
}
const MAIL = [];
class FakeResend { constructor() { this.emails = { send: async (p) => { MAIL.push(p); return { data: { id: 'm' + MAIL.length } }; } }; } }
const toOf = (p) => (Array.isArray(p.to) ? p.to[0] : p.to);

function seed() {
  for (const k of Object.keys(DB)) delete DB[k];
  DB.schedule = {};
  const byWeek = {};
  for (const m of seasonMatches) (byWeek[m.week] ||= []).push({ ...m });
  for (const [week, matches] of Object.entries(byWeek)) {
    DB.schedule[`schedule/II/3.5+Mix/week-${week}.json`] = { circuit: 'II', division: '3.5+Mix', week: Number(week), matches };
  }
  DB.teams = {};
  for (const t of teamsById.values()) DB.teams[`team/${t.id}.json`] = structuredClone(t);
  const hhh = DB.teams['team/hhh.json'].roster;
  hhh.find(p => p.id === 'kevin').email = '';            // address only on his Season 1 entry
  hhh.find(p => p.id === 'dot').email = '';              // no address anywhere
  hhh.find(p => p.id === 'jason').isSub = true;          // subs are never auto-reminded
  const kc = hhh.find(p => p.id === 'kc'); kc.normalizedEmail = 'kc@example.com'; delete kc.email;
  DB.teams['team/old.json'] = { id: 'old', name: 'Old Team', circuit: 'I', roster: [{ id: 'kevin_s1', name: 'Kevin Vu', email: 'kevin.s1@example.com' }] };
  DB['league-identity'] = { 'map.json': { links: { kevin: { to: 'kevin_s1' } }, splits: {} } };
  // Richard already answered for Week 5.
  DB.availability = { 'availability/m_II_w5_3/hhh.json': { matchId: 'm_II_w5_3', teamId: 'hhh', players: { rich: { status: 'in' } } } };
  DB.seasons = {
    'circuit-i': { id: 'circuit-i', name: 'Season 1', startDate: '2026-05-18', weeks: 8 },
    'circuit-ii': { id: 'circuit-ii', name: 'Season 2', startDate: '2026-09-17', weeks: 11 },
  };
  MAIL.length = 0;
}

let skip = false, cron, Tok;
try {
  process.env.RESEND_API_KEY = 'test';
  process.env.SITE_URL = 'https://example.test';
  process.env.AVAILABILITY_TOKEN_SECRET = 'test-secret';
  mock.module('@netlify/blobs', { namedExports: { getStore: (arg) => store(typeof arg === 'string' ? arg : arg.name) } });
  mock.module('resend', { namedExports: { Resend: FakeResend } });
  ({ default: cron } = await import('../netlify/functions/availability-reminder-cron.js'));
  Tok = await import('../netlify/functions/lib/availability-token.js');
} catch (e) {
  skip = 'needs --experimental-test-module-mocks (' + (e && e.message ? e.message.slice(0, 160) : e) + ')';
}

// Week 5 is Thursday Oct 15, 6:00 PM Pacific (2026-10-16T01:00Z).
const at = (iso) => mock.timers.enable({ apis: ['Date'], now: new Date(iso).getTime() });

test('the cron reminds the LIVE season, and reaches players whose address is not on their own entry', { skip }, async (t) => {
  seed();
  t.after(() => mock.timers.reset());
  at('2026-10-12T17:00:00Z');                             // Mon Oct 12, 10:00 AM Pacific — inside the 4-day window
  await cron();

  const hitters = MAIL.filter(p => p.html.includes('Happy Hour Hitters')).map(toOf).sort();
  // Everyone on the Hitters except: Richard (answered), Jason (sub), Dot (no address).
  assert.deepEqual(hitters, ['devin@example.com', 'kc@example.com', 'kevin.s1@example.com', 'pam@example.com', 'shalynn@example.com']);
  // Bonkerz play Big Dink Energy in Week 5 — all seven get one too.
  assert.equal(MAIL.filter(p => p.html.includes('Bonkerz')).length, 7);
  assert.ok(MAIL.every(p => p.subject === 'Confirm your availability — Week 5'));

  // Kevin's buttons act for his Season 2 roster entry on the Week 5 match.
  const kevin = MAIL.find(p => toOf(p) === 'kevin.s1@example.com').html;
  const tokens = [...kevin.matchAll(/availability-confirm\?t=([^"&]+)/g)].map(m => Tok.verifyAvailabilityToken(decodeURIComponent(m[1])));
  assert.deepEqual(tokens.map(x => [x.matchId, x.teamId, x.playerId, x.status]), [
    ['m_II_w5_3', 'hhh', 'kevin', 'in'], ['m_II_w5_3', 'hhh', 'kevin', 'out'],
  ]);
});

test('one reminder a day, none for someone who has answered since', { skip }, async (t) => {
  seed();
  t.after(() => mock.timers.reset());
  at('2026-10-12T17:00:00Z');
  await cron();
  const first = MAIL.length;
  await cron();                                           // next tick, same day
  assert.equal(MAIL.length, first);

  DB.availability['availability/m_II_w5_3/hhh.json'].players.pam = { status: 'out' };
  mock.timers.reset(); at('2026-10-13T17:00:00Z');        // Tuesday
  MAIL.length = 0;
  await cron();
  const hitters = MAIL.filter(p => p.html.includes('Happy Hour Hitters')).map(toOf).sort();
  assert.deepEqual(hitters, ['devin@example.com', 'kc@example.com', 'kevin.s1@example.com', 'shalynn@example.com']);
});

test('nothing goes out more than four days ahead, at night, or once the lineup locks', { skip }, async (t) => {
  seed();
  t.after(() => mock.timers.reset());
  for (const when of ['2026-10-10T17:00:00Z',             // Saturday: five days out
    '2026-10-13T05:30:00Z',                               // Monday 10:30 PM Pacific
    '2026-10-16T00:45:00Z']) {                            // Thursday 5:45 PM: lineups locked at 5:30
    mock.timers.reset(); at(when);
    await cron();
    assert.equal(MAIL.length, 0, when);
  }
});
