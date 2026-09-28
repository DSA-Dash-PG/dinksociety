// tests/traffic.test.js — pure helpers + report maths behind the admin Traffic page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pacificDay, pacificHour, dayRange, addDays, cleanPath, cleanQuery, cleanHash, screenKey,
  refHost, parseDevice, isBot, cleanId, buildSessions, buildReport, attribute, personKey,
} from '../netlify/functions/lib/traffic.js';

test('Pacific day/hour, not UTC', () => {
  const t = Date.parse('2026-09-27T05:30:00Z'); // 10:30pm PDT on the 26th
  assert.equal(pacificDay(t), '2026-09-26');
  assert.equal(pacificHour(t), 22);
  assert.deepEqual(dayRange('2026-09-29', '2026-10-02'), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  assert.equal(addDays('2026-11-01', 1), '2026-11-02'); // DST weekend
});

test('paths, query whitelist, hash tabs', () => {
  assert.equal(cleanPath('/Schedule.html?x=1'), '/schedule');
  assert.equal(cleanPath('/index.html'), '/');
  assert.equal(cleanPath('/ladders/recaps/'), '/ladders/recaps');
  assert.deepEqual(cleanQuery({ token: 'secret', slug: 'bonkerz', email: 'a@b.c' }), { slug: 'bonkerz' });
  assert.equal(cleanHash('#lineup'), 'lineup');
  assert.equal(cleanHash('#access_token=abc.def'), '');
  assert.equal(screenKey({ path: '/leaderboard', q: { tab: 'Players' }, h: '' }), '/leaderboard#players');
  assert.equal(screenKey({ path: '/me', q: {}, h: 'schedule' }), '/me#schedule');
});

test('referrer, device, bots, ids', () => {
  assert.equal(refHost('https://l.instagram.com/?u=x'), 'instagram.com');
  assert.equal(refHost('https://www.google.com/'), 'google.com');
  assert.equal(parseDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1').type, 'mobile');
  assert.equal(parseDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', { touch: true }).os, 'iPadOS');
  assert.equal(parseDevice('Mozilla/5.0 (iPhone) Instagram 300.0').br, 'Instagram');
  assert.equal(parseDevice('x', { pwa: true }).br, 'App');
  assert.ok(isBot('Googlebot/2.1'));
  assert.ok(!isBot('Mozilla/5.0 (iPhone)'));
  assert.equal(cleanId('ABCdef123456'), 'abcdef123456');
  assert.equal(cleanId('../etc'), null);
});

test('sessions, people, time on page and site', () => {
  const base = Date.parse('2026-09-24T01:00:00Z'); // 6pm PDT
  const lee = { k: 'player', n: 'Lee Cox', e: 'lee@x.com', t: 'Bonkerz' };
  const rows = [
    { id: 'a', sid: 's1', vid: 'v1', at: base, last: base + 60e3, ms: 50e3, sc: 80, s: '/', title: 'Home', who: lee, dev: 'mobile' },
    { id: 'b', sid: 's1', vid: 'v1', at: base + 61e3, last: base + 300e3, ms: 200e3, sc: 100, s: '/schedule', title: 'Schedule', who: lee, dev: 'mobile' },
    { id: 'c', sid: 's2', vid: 'v2', at: base + 10e3, last: base + 20e3, ms: 8e3, sc: 10, s: '/', title: 'Home', who: { k: 'anon' }, dev: 'desktop', ref: 'instagram.com' },
    { id: 'd', sid: 's3', vid: 'v1', at: base + 7200e3, last: base + 7300e3, ms: 30e3, sc: 0, s: '/standings', title: 'Standings', who: { k: 'anon' }, dev: 'mobile' },
  ];
  const vidMap = new Map([['v1', { ...lee, at: base }]]);
  attribute(rows, vidMap);
  assert.equal(rows[3].who.n, 'Lee Cox');
  assert.ok(rows[3].who.inferred);
  assert.equal(personKey(rows[3].who, 'v1'), 'e:lee@x.com');

  const sessions = buildSessions(rows);
  assert.equal(sessions.length, 3);
  const s1 = sessions.find(s => s.sid === 's1');
  assert.equal(s1.ms, 250e3);
  assert.deepEqual(s1.pages.map(p => p.s), ['/', '/schedule']);

  const R = buildReport(rows, { from: '2026-09-23', to: '2026-09-23' });
  assert.equal(R.kpis.pageviews, 4);
  assert.equal(R.kpis.visitors, 2);
  assert.equal(R.kpis.signedIn, 1);
  assert.equal(R.kpis.sessions, 3);
  assert.equal(R.kpis.bounceRate, 67);
  const lr = R.people.find(p => p.key === 'e:lee@x.com');
  assert.equal(lr.sessions, 2);
  assert.equal(lr.ms, 280e3);
  assert.equal(lr.top, '/schedule');
  const home = R.pages.find(p => p.s === '/');
  assert.equal(home.views, 2);
  assert.equal(home.avgMs, 29e3);
  assert.equal(home.entries, 2);
  assert.equal(R.byHour[18].pv, 2 + 1); // 6pm PDT: a, b, c
  assert.equal(R.referrers.find(r => r.label === 'instagram.com').n, 1);
});
