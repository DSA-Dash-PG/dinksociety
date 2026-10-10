// tests/night-recap-send.test.js
//
// The sending half of the league "morning-after" email, run for real against an
// in-memory stand-in for Netlify Blobs and a fake mail client: who gets mailed,
// that nobody gets it twice, that opt-outs and missing addresses are handled,
// that the in/out buttons carry the right signed tokens, and that the cron only
// fires when a night is due and was played after auto-send was switched on.
//
//   node --test --experimental-test-module-mocks tests/night-recap-send.test.js
//
// Without that flag these tests skip themselves rather than failing the suite.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  seasonMatches, lineupHHH, lineupBonk, scoreHHHvBonk, playerStats, performers, teamsById,
} from './fixtures/night-recap-week4.js';

// ── In-memory Netlify Blobs + fake Resend + captured fetch ─────────
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
let FAIL_TO = null;
class FakeResend {
  constructor() {
    this.emails = { send: async (p) => {
      const to = Array.isArray(p.to) ? p.to[0] : p.to;
      if (FAIL_TO && to === FAIL_TO) return { error: { message: 'mailbox on fire' } };
      MAIL.push(p); return { data: { id: 'm' + MAIL.length } };
    } };
  }
}
const FETCHES = [];
let ADMIN = null;
let skip = false;
let NR, bgHandler, Prefs, Tok;
const realSetTimeout = globalThis.setTimeout;

function seed({ week5Final = false } = {}) {
  for (const k of Object.keys(DB)) delete DB[k];
  const byWeek = {};
  for (const m of seasonMatches) {
    const mm = { ...m };
    if (week5Final && m.week === 5) Object.assign(mm, { finalizedAt: '2026-10-16T03:40:00.000Z', scoreA: 2, scoreB: 2, round1: { homeGames: 3, awayGames: 3 }, round2: { homeGames: 3, awayGames: 3 }, pointsA: 100, pointsB: 100 });
    (byWeek[m.week] ||= []).push(mm);
  }
  for (const [week, matches] of Object.entries(byWeek)) {
    DB.schedule ||= {};
    DB.schedule[`schedule/II/3.5+Mix/week-${week}.json`] = { circuit: 'II', division: '3.5+Mix', week: Number(week), matches };
  }
  DB.teams = {};
  for (const t of teamsById.values()) DB.teams[`team/${t.id}.json`] = structuredClone(t);
  // Kevin's Season 2 entry has no address; his Season 1 entry (same person, linked) does.
  DB.teams['team/hhh.json'].roster.find(p => p.id === 'kevin').email = '';
  DB.teams['team/old.json'] = { id: 'old', name: 'Old Team', circuit: 'I', roster: [{ id: 'kevin_s1', name: 'Kevin Vu', email: 'kevin.s1@example.com' }] };
  DB['league-identity'] = { 'map.json': { links: { kevin: { to: 'kevin_s1' } }, splits: {} } };
  // Dot has no address anywhere.
  DB.teams['team/hhh.json'].roster.find(p => p.id === 'dot').email = '';
  DB.lineups = { 'lineup/m_II_w4_2/hhh.json': lineupHHH, 'lineup/m_II_w4_2/bonk.json': lineupBonk };
  DB.scores = { 'score/m_II_w4_2.json': structuredClone(scoreHHHvBonk) };
  DB['player-stats'] = { 'player-stats/II.json': playerStats };
  DB.standings = { 'standings/II.json': { circuit: 'II', weeklyTopPerformers: [performers] } };
  DB.seasons = { 'circuit-ii': { id: 'circuit-ii', name: 'Season 2', startDate: '2026-09-17', weeks: 11 } };
  MAIL.length = 0; FETCHES.length = 0; FAIL_TO = null;
}

try {
  process.env.RESEND_API_KEY = 'test';
  process.env.SITE_URL = 'https://example.test';
  process.env.AVAILABILITY_TOKEN_SECRET = 'test-secret';
  mock.module('@netlify/blobs', { namedExports: { getStore: (arg) => store(typeof arg === 'string' ? arg : arg.name) } });
  mock.module('resend', { namedExports: { Resend: FakeResend } });
  mock.module(new URL('../netlify/functions/lib/auth.js', import.meta.url).href, { namedExports: {
    verifyAdminSession: async () => ADMIN ? { valid: true, payload: { email: ADMIN } } : { valid: false, error: 'Unauthorized' },
    verifyCaptainSession: async () => ({ valid: false }),
    verifyPlayerSession: async () => ({ valid: false }),
    unauthResponse: (e) => new Response(JSON.stringify({ error: e || 'Unauthorized' }), { status: 401 }),
  } });
  globalThis.fetch = async (u, opts) => { FETCHES.push({ url: String(u), opts }); return new Response('', { status: 202 }); };
  // The sender paces itself under Resend's rate limit; tests do not need the wait.
  globalThis.setTimeout = (fn, _ms, ...a) => realSetTimeout(fn, 0, ...a);
  NR = await import('../netlify/functions/lib/night-recap.js');
  Prefs = await import('../netlify/functions/lib/notify-prefs.js');
  Tok = await import('../netlify/functions/lib/availability-token.js');
  ({ default: bgHandler } = await import('../netlify/functions/night-recap-send-background.js'));
} catch (e) {
  skip = 'needs --experimental-test-module-mocks (' + (e && e.message ? e.message.slice(0, 160) : e) + ')';
}

const toOf = (p) => (Array.isArray(p.to) ? p.to[0] : p.to);

test('loadWeek builds a model for everyone on the card from the stored blobs', { skip }, async () => {
  seed();
  const wk = await NR.loadWeek('II', 4);
  assert.equal(wk.ok, true);
  assert.equal(wk.models.length, 13);
  const rich = wk.models.find(m => m.playerId === 'rich');
  assert.deepEqual([rich.night.w, rich.night.l, rich.season.rank, rich.next.oppName], [1, 3, 19, 'Smash Society']);
  assert.equal((await NR.loadWeek('II', 9)).ok, false);
});

test('sendWeek mails each player once, finds a linked address, and reports who it could not reach', { skip }, async () => {
  seed();
  await Prefs.setPrefs('pam@example.com', { all: false });            // Pam unsubscribed from everything
  const out = await NR.sendWeek('II', 4, { by: 'test' });
  assert.equal(out.ok, true);
  // 13 played − Dot (no address) − Pam (opted out) = 11
  assert.equal(MAIL.length, 11);
  assert.equal(new Set(MAIL.map(toOf)).size, 11);
  assert.ok(MAIL.some(p => toOf(p) === 'kevin.s1@example.com'), "Kevin's linked Season 1 address");
  assert.ok(!MAIL.some(p => toOf(p) === 'pam@example.com'));
  assert.deepEqual(out.noEmail, ['Dot M. (Happy Hour Hitters)']);
  assert.deepEqual([out.sentThisRun, out.optedOut, out.failed.length], [11, 1, 0]);

  const rich = MAIL.find(p => toOf(p) === 'rich@example.com');
  assert.equal(rich.subject, 'Richard, your Week 4 receipt: 1–3, now 19th overall');
  assert.ok(rich.html.includes('Manage email preferences'), 'goes through the recap preference footer');
  assert.ok(rich.headers?.['List-Unsubscribe']);

  const state = await NR.getState('II', 4);
  assert.deepEqual([state.status, state.sent, state.kickToken], ['sent', 11, null]);
});

test('the in/out buttons carry signed tokens for the right player, match and answer', { skip }, async () => {
  seed();
  await NR.sendWeek('II', 4);
  const html = MAIL.find(p => toOf(p) === 'rich@example.com').html;
  const tokens = [...html.matchAll(/availability-confirm\?t=([^"&]+)/g)].map(m => decodeURIComponent(m[1]));
  assert.equal(tokens.length, 2);
  assert.deepEqual(tokens.map(t => Tok.verifyAvailabilityToken(t)), [
    { matchId: 'm_II_w5_3', teamId: 'hhh', playerId: 'rich', status: 'in' },
    { matchId: 'm_II_w5_3', teamId: 'hhh', playerId: 'rich', status: 'out' },
  ]);
});

test('a player who already answered sees their answer, not two fresh buttons', { skip }, async () => {
  seed();
  DB.availability = { 'availability/m_II_w5_3/hhh.json': { matchId: 'm_II_w5_3', teamId: 'hhh', players: { rich: { status: 'out' } } } };
  await NR.sendWeek('II', 4);
  const html = MAIL.find(p => toOf(p) === 'rich@example.com').html;
  assert.ok(html.includes('>OUT</b>') && html.includes('I can play after all') && !html.includes("I'm in for Week 5"));
});

test('running the week again mails nobody twice, and picks up anyone who failed', { skip }, async () => {
  seed();
  FAIL_TO = 'kayo@example.com';
  const first = await NR.sendWeek('II', 4);
  assert.deepEqual([first.sentThisRun, first.failed.map(f => f.name)], [11, ['Kayo Hayashi']]);
  assert.equal((await NR.sendWeek('II', 4)).skipped, true, 'a sent week is not reopened on its own');

  // "Send week now" re-queues it; only the one who missed out is mailed.
  FAIL_TO = null; MAIL.length = 0;
  const q = await NR.queueWeek('II', 4, { by: 'admin', force: true });
  assert.equal(q.ok, true);
  const again = await NR.sendWeek('II', 4);
  assert.deepEqual([MAIL.map(toOf), again.sentThisRun, again.failed.length], [['kayo@example.com'], 1, 0]);
});

test('preview and test sends never carry live in/out links or touch the ledger', { skip }, async () => {
  seed();
  const pv = await NR.previewFor('II', 4, 'rich');
  assert.equal(pv.ok, true);
  assert.ok(!pv.html.includes('availability-confirm') && pv.html.includes("I'm in for Week 5"));
  const t = await NR.sendTest('II', 4, 'rich', 'Boss@Example.test');
  assert.deepEqual([t.ok, t.to, MAIL.length, MAIL[0].subject], [true, 'boss@example.test', 1, '[Test] Richard, your Week 4 receipt: 1–3, now 19th overall']);
  assert.equal(await NR.getState('II', 4), null);
  assert.equal((await NR.previewFor('II', 4, 'shalynn')).ok, false);
  const list = await NR.listWeekPlayers('II', 4);
  assert.deepEqual([list.players.length, list.players.find(p => p.playerId === 'dot').hasEmail, list.players.every(p => !p.sent)], [13, false, true]);
});

test('the cron leaves a night played before auto-send was switched on alone', { skip }, async () => {
  seed();
  const out = await NR.runDue(new Date('2026-10-09T14:45:00Z'));     // Fri Oct 9, 7:45 AM Pacific
  assert.deepEqual([out.sent, out.week, out.reason], [false, 4, 'night was played before auto-send was switched on']);
  assert.equal(FETCHES.length, 0);
});

test('the cron queues a due week once and hands the background sender a one-time kick', { skip }, async () => {
  seed({ week5Final: true });
  const early = await NR.runDue(new Date('2026-10-16T14:00:00Z'));   // Fri Oct 16, 7:00 AM Pacific
  assert.deepEqual([early.sent, early.reason], [false, 'before 7:30 AM Pacific']);

  const out = await NR.runDue(new Date('2026-10-16T14:45:00Z'));     // 7:45 AM
  assert.deepEqual([out.sent, out.week, out.circuit], [true, 5, 'II']);
  assert.equal(FETCHES.length, 1);
  assert.ok(FETCHES[0].url.endsWith('/.netlify/functions/night-recap-send-background'));
  const kick = FETCHES[0].opts.headers['x-night-recap-kick'];
  assert.equal(kick.length, 48);
  assert.deepEqual(JSON.parse(FETCHES[0].opts.body), { circuit: 'II', week: 5 });

  const again = await NR.runDue(new Date('2026-10-16T15:00:00Z'));   // next tick, still in flight
  assert.deepEqual([again.sent, again.reason, FETCHES.length], [false, 'already queued', 1]);

  await NR.setAutoSend(false, 'boss@example.test');
  assert.equal((await NR.runDue(new Date('2026-10-16T15:15:00Z'))).reason, 'auto-send is off');
});

test('the background sender only accepts the pinned kick or an admin, and only a queued week', { skip }, async () => {
  seed();
  const post = (headers = {}) => bgHandler(new Request('https://example.test/.netlify/functions/night-recap-send-background', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ circuit: 'II', week: 4 }),
  }));
  ADMIN = null;
  assert.equal((await post()).status, 401);
  const q = await NR.queueWeek('II', 4, { by: 'cron' });
  assert.equal((await post({ 'x-night-recap-kick': 'x'.repeat(48) })).status, 401);
  assert.equal(MAIL.length, 0);

  const ok = await post({ 'x-night-recap-kick': q.kickToken });
  assert.equal(ok.status, 200);
  assert.equal(MAIL.length, 12);                                     // 13 played − Dot (no address)
  // The kick is spent: replaying it does nothing, and neither does an admin on a finished week.
  assert.equal((await post({ 'x-night-recap-kick': q.kickToken })).status, 401);
  ADMIN = 'boss@example.test';
  const body = await (await post()).json();
  assert.deepEqual([body.skipped, body.status, MAIL.length], [true, 'sent', 12]);
  ADMIN = null;
});

test('switching auto-send back on only covers nights from then on', { skip }, async () => {
  seed();
  await NR.setAutoSend(false);
  const before = Date.now();
  const s = await NR.setAutoSend(true, 'boss@example.test');
  assert.ok(s.autoSend && new Date(s.since).getTime() >= before);
  assert.equal((await NR.statusFor('II', new Date('2026-10-09T15:00:00Z'))).coveredByAutoSend, false);
});
