// tests/ladder-messages.test.js
//
// Ladder updates (messages to one ladder's players) and the DUPR club step.
//
// The first half is pure. The second half runs the real endpoints against an
// in-memory stand-in for Netlify Blobs and a fake mail client, so it needs:
//
//   node --test --experimental-test-module-mocks tests/
//
// Without that flag those tests skip themselves rather than failing the suite.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── In-memory Netlify Blobs + fake Resend ──────────────────────────
const DB = {};
function store(name) {
  const bag = DB[name] || (DB[name] = {});
  return {
    async get(key, opts) { const v = bag[key]; if (v === undefined) return null; return opts?.type === 'json' ? structuredClone(v) : JSON.stringify(v); },
    async setJSON(key, val) { bag[key] = structuredClone(val); },
    async list(opts) { const p = opts?.prefix || ''; return { blobs: Object.keys(bag).filter(k => k.startsWith(p)).map(key => ({ key })) }; },
    async delete(key) { delete bag[key]; },
  };
}
const MAIL = [];
const ORG_STORE = 'ladder-organizers';
class FakeResend { constructor() { this.emails = { send: async (p) => { MAIL.push(p); return { data: { id: 'x' } }; } }; } }

const url = (p) => new URL(p, import.meta.url).href;
let WHO = { admin: null, player: null };   // who the mocked sessions say is signed in
let skip = false;
let M, R, D, L, saveHandler, msgHandler, signupHandler, manageHandler, eventsHandler, orgSaveHandler;
try {
  process.env.RESEND_API_KEY = 'test';
  process.env.SITE_URL = 'https://example.test';
  mock.module('@netlify/blobs', { namedExports: { getStore: (arg) => store(typeof arg === 'string' ? arg : arg.name) } });
  mock.module('resend', { namedExports: { Resend: FakeResend } });
  mock.module(url('../netlify/functions/lib/auth.js'), { namedExports: {
    verifyAdminSession: async () => WHO.admin ? { valid: true, payload: { email: WHO.admin } } : { valid: false, error: 'no' },
    verifyCaptainSession: async () => ({ valid: false }),
    verifyPlayerSession: async () => WHO.player ? { valid: true, payload: { playerId: WHO.player.id, session: { email: WHO.player.email }, player: { name: WHO.player.name, email: WHO.player.email, gender: WHO.player.gender || 'M' } } } : { valid: false, error: 'no' },
    unauthResponse: (e) => new Response(JSON.stringify({ error: e || 'Unauthorized' }), { status: 401 }),
  } });
  M = await import('../netlify/functions/lib/ladder-messages.js');
  R = await import('../netlify/functions/lib/ladder-reminders.js');
  D = await import('../netlify/functions/lib/player-directory.js');
  L = await import('../netlify/functions/lib/ladder.js');
  ({ default: saveHandler } = await import('../netlify/functions/admin-ladder-save.js'));
  ({ default: orgSaveHandler } = await import('../netlify/functions/organizer-ladder-save.js'));
  ({ default: msgHandler } = await import('../netlify/functions/admin-ladder-message.js'));
  ({ default: signupHandler } = await import('../netlify/functions/ladder-signup.js'));
  ({ default: manageHandler } = await import('../netlify/functions/admin-ladder-manage.js'));
  ({ default: eventsHandler } = await import('../netlify/functions/player-ladder-events.js'));
} catch (e) {
  skip = 'needs --experimental-test-module-mocks (' + (e && e.message ? e.message.slice(0, 80) : e) + ')';
}

const post = (path, body) => new Request('https://example.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = (path) => new Request('https://example.test' + path);
const soon = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function seedLadder(id, over = {}) {
  const ev = { id, circuit: 'I', name: 'Friday Ladder', date: soon(10), startTime: '6:00 PM', endTime: '8:00 PM', place: 'South End', address: '1 Court Way', courts: 3, courtNames: ['A', 'B', 'C'], courtNumbers: 'A · B · C', capacity: 12, feeCents: 0, free: true, paymentMethods: ['free'], status: 'open', ...over };
  await L.setEvent(ev);
  await L.setSignups({ eventId: id, roster: [
    { playerId: 'p1', name: 'Ana Ruiz', email: 'ana@example.com', paymentStatus: 'paid' },
    { playerId: 'p2', name: 'Ben Cho', email: 'BEN@example.com', paymentStatus: 'paid', duprClub: 'verified' },
    { playerId: 'p3', name: 'No Email', email: '' },
  ], waitlist: [{ playerId: 'p4', name: 'Cy Wait', email: 'cy@example.com' }], pendingClaim: null });
  return ev;
}

// ═══════════ pure ═══════════

test('describeChanges: nothing a player cares about → empty', { skip }, () => {
  const a = { date: '2026-10-09', startTime: '6:00 PM', place: 'South End', courts: 3, name: 'A', feeCents: 1000 };
  assert.deepEqual(M.describeChanges(a, { ...a, name: 'B', feeCents: 1500, capacity: 16 }), []);
});

test('describeChanges: date, time, place and courts, in plain words', { skip }, () => {
  const a = { date: '2026-10-09', startTime: '6:00 PM', endTime: '8:00 PM', place: 'South End', address: '', courtNumbers: 'A · B' };
  const b = { date: '2026-10-16', startTime: '7:00 PM', endTime: '8:00 PM', place: 'Wilson Park', address: '2200 Crenshaw', courtNumbers: '5A · 5B' };
  const ch = M.describeChanges(a, b);
  assert.deepEqual(ch.map(c => c.field), ['date', 'startTime', 'place', 'address', 'courts']);
  assert.equal(M.changeLine(ch[0]), 'Date: Fri, Oct 9 → Fri, Oct 16');
  assert.equal(M.changeLine(ch[1]), 'Start time: 6:00 PM → 7:00 PM');
  assert.equal(M.changeLine(ch[3]), 'Address: 2200 Crenshaw');
  assert.equal(M.changesMoveStart(ch), true);
  assert.equal(M.changesMoveStart(ch.filter(c => c.field === 'place')), false);
});

test('pickRecipients: roster by default, waitlist on request, one email each', { skip }, () => {
  const s = { roster: [{ name: 'A', email: 'a@x.co' }, { name: 'A2', email: 'A@x.co' }, { name: 'none', email: '' }, { name: 'B', email: 'b@x.co', duprClub: 'verified' }],
              waitlist: [{ name: 'C', email: 'c@x.co' }, { name: 'A again', email: 'a@x.co' }] };
  assert.deepEqual(M.pickRecipients(s).map(p => p.email), ['a@x.co', 'b@x.co']);
  assert.deepEqual(M.pickRecipients(s, { roster: true, waitlist: true }).map(p => p.email + ':' + p.list), ['a@x.co:roster', 'b@x.co:roster', 'c@x.co:waitlist']);
  assert.deepEqual(M.pickRecipients(s, { roster: false, waitlist: true }).map(p => p.email), ['c@x.co', 'a@x.co']);
  assert.deepEqual(M.pickRecipients(s, { roster: true, only: 'dupr-unverified' }).map(p => p.email), ['a@x.co']);
  assert.deepEqual(M.audienceCounts(s), { roster: 2, waitlist: 2, duprUnverified: 1 });
});

test('sanitizeMessageHtml drops scripts, handlers and unsafe links, keeps the text', { skip }, () => {
  const out = M.sanitizeMessageHtml('<p onclick="x()">Hi <b>all</b><script>alert(1)</script><img src=x onerror=1> <a href="javascript:alert(1)">bad</a> <a href="https://ok.test">ok</a></p>');
  assert.ok(!/script|onclick|onerror|javascript:|<img/i.test(out));
  assert.match(out, /<p>Hi <b>all<\/b>/);
  assert.match(out, /<a href="https:\/\/ok\.test" target="_blank"/);
});

test('ladder entries carry the DUPR fields, including waitlist → roster', { skip }, () => {
  const ev = { capacity: 1, courts: 1 };
  const rec = { roster: [], waitlist: [] };
  L.addSignup(rec, ev, { playerId: 'a', name: 'A', email: 'a@x.co', duprId: 'D1', duprClub: 'confirmed' });
  L.addSignup(rec, ev, { playerId: 'b', name: 'B', email: 'b@x.co', duprId: 'D2', duprClub: 'confirmed' });
  assert.equal(rec.roster[0].duprClub, 'confirmed');
  assert.equal(rec.waitlist[0].duprClub, 'confirmed');
  rec.roster.length = 0;
  const moved = L.moveWaitlistToRoster(rec, { playerId: 'b' });
  assert.equal(moved.duprId, 'D2');
  assert.equal(moved.duprClub, 'confirmed');
});

// ═══════════ against the in-memory store ═══════════

test('sendLadderMessage emails the audience, logs it, and the portal feed respects the list', { skip }, async () => {
  const ev = await seedLadder('ev1');
  MAIL.length = 0;
  const r1 = await M.sendLadderMessage({ event: ev, subject: '', bodyHtml: '<p>Courts moved to <b>5A</b>.</p>', audience: { roster: true }, kind: 'update', sentBy: 'admin@x.co' });
  assert.equal(r1.sent, 2);
  assert.deepEqual(MAIL.map(m => m.to).sort(), ['ana@example.com', 'ben@example.com']);
  assert.match(MAIL[0].subject, /^Update: Friday Ladder/);
  assert.match(MAIL[0].html, /Ladder update/);
  assert.match(MAIL[0].html, /maps\.google\.com/);

  MAIL.length = 0;
  const r2 = await M.sendLadderMessage({ event: ev, subject: 'Parking', bodyHtml: '<p>Park on 2nd St.</p>', audience: { roster: true, waitlist: true }, sentBy: 'admin@x.co' });
  assert.equal(r2.sent, 3);
  await M.sendLadderMessage({ event: ev, subject: 'Join the club', bodyHtml: '<p>Join the DUPR club.</p>', audience: { roster: true, only: 'dupr-unverified' } });

  const log = await M.listEventMessages('ev1');
  assert.deepEqual(log.map(m => m.subject), ['Join the club', 'Parking', 'Update: Friday Ladder']);
  assert.ok(log[2].message.includes('Courts moved to'));

  // roster sees both general messages, not the narrowed one; waitlist only what was sent to it
  assert.deepEqual((await M.updatesForPlayer('ev1', 'roster')).map(u => u.subject), ['Parking', 'Update: Friday Ladder']);
  assert.deepEqual((await M.updatesForPlayer('ev1', 'waitlist')).map(u => u.subject), ['Parking']);
  assert.deepEqual((await M.updatesForPlayer('ev1', 'claim')).map(u => u.subject), ['Parking']);
});

test('messages logged before the per-ladder index are still listed', { skip }, async () => {
  await store('ladder-messages').setJSON('message/lm_old.json', { id: 'lm_old', eventId: 'evOld', subject: 'Old one', message: 'hello', sentAt: '2026-08-01T00:00:00Z' });
  const log = await M.listEventMessages('evOld');
  assert.deepEqual(log.map(m => m.id), ['lm_old']);
  assert.ok(DB['ladder-messages']['event/evOld.json']);
});

test('saving a ladder reports what changed and who it affects; nothing is sent', { skip }, async () => {
  const ev = await seedLadder('ev2');
  WHO.admin = 'boss@x.co';
  MAIL.length = 0;
  const same = await (await saveHandler(post('/x', { ...ev, name: 'Friday Ladder (renamed)' }))).json();
  assert.deepEqual(same.changes, []);
  const res = await (await saveHandler(post('/x', { ...ev, startTime: '7:00 PM', place: 'Wilson Park' }))).json();
  assert.deepEqual(res.changes.map(c => c.field), ['startTime', 'place']);
  assert.deepEqual(res.affected, { roster: 2, waitlist: 1, duprUnverified: 1 });
  assert.equal(MAIL.length, 0);
  WHO.admin = null;
});

test('moving the date clears hand-pushed reminders that are still ahead', { skip }, async () => {
  const ev = await seedLadder('ev3', { date: soon(10) });
  const rem = store('ladder-reminders');
  for (const k of ['two_day', 'morning', 'three_hour']) await rem.setJSON(`sent/ev3/${k}.json`, { eventId: 'ev3', kind: k, at: new Date().toISOString(), forced: true });
  const cleared = await R.resetRemindersForReschedule({ ...ev, date: soon(12) });
  assert.deepEqual(cleared.sort(), ['morning', 'three_hour', 'two_day']);
  // a ladder starting within the hour: nothing left to re-send
  for (const k of ['two_day', 'morning', 'three_hour']) await rem.setJSON(`sent/ev3/${k}.json`, { eventId: 'ev3', kind: k, at: new Date().toISOString(), forced: true });
  const d = new Date(Date.now() - 3600000);
  const past = await R.resetRemindersForReschedule({ ...ev, date: d.toISOString().slice(0, 10), startTime: '12:01 AM' }, Date.now() + 40 * 86400000);
  assert.deepEqual(past, []);
});

test('admin-ladder-message: admin sends, organizer only on their own ladder, history comes back', { skip }, async () => {
  await seedLadder('ev4');
  await seedLadder('ev5', { ownerEmail: 'org@x.co' });
  await store(ORG_STORE).setJSON('org/org@x.co.json', { email: 'org@x.co', status: 'active', name: 'Org' });
  // signed out
  WHO = { admin: null, player: null };
  assert.equal((await msgHandler(post('/x', { eventId: 'ev4', message: 'hi' }))).status, 401);
  // admin
  WHO.admin = 'boss@x.co';
  MAIL.length = 0;
  const a = await (await msgHandler(post('/x', { eventId: 'ev4', message: 'Line one\nLine two', audience: { roster: true, waitlist: true }, kind: 'update', changes: [{ field: 'place', label: 'Location', from: 'A', to: 'B' }] }))).json();
  assert.equal(a.sent, 3);
  assert.match(MAIL[0].html, /Line one<br>Line two/);
  assert.equal((await msgHandler(post('/x', { eventId: 'ev4', message: '   ' }))).status, 400);
  assert.equal((await msgHandler(post('/x', { eventId: 'ev4', message: 'x', audience: { roster: false, waitlist: false } }))).status, 400);
  const hist = await (await msgHandler(get('/x?eventId=ev4'))).json();
  assert.equal(hist.messages.length, 1);
  assert.equal(hist.messages[0].kind, 'update');
  assert.deepEqual(hist.messages[0].changes, [{ field: 'place', label: 'Location', from: 'A', to: 'B' }]);
  assert.deepEqual(hist.counts, { roster: 2, waitlist: 1, duprUnverified: 1 });
  WHO.admin = null;
});

test('DUPR-rated sign-up needs the club box ticked; a verified player is not asked again', { skip }, async () => {
  await seedLadder('ev6', { duprRated: true });
  WHO = { admin: null, player: { id: 'p9', email: 'new@example.com', name: 'New Player' } };
  const url6 = '/x?event=ev6';
  let r = await signupHandler(post(url6, { paymentMethod: 'free', duprId: 'ABC123' }));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.match(body.error, /Join the Dink Society - South Bay club on DUPR/);
  assert.match(body.duprClubUrl, /dupr\.com/);
  r = await signupHandler(post(url6, { paymentMethod: 'free', duprId: 'ABC123', duprClub: true }));
  assert.equal(r.status, 200);
  let s = await L.getSignups('ev6');
  const mine = s.roster.find(p => p.playerId === 'p9');
  assert.equal(mine.duprClub, 'confirmed');
  assert.equal((await D.getDirectory()).p9.duprClub, 'confirmed');

  // admin verifies them on the roster → saved on the entry and the profile
  WHO = { admin: 'boss@x.co', player: null };
  const v = await (await manageHandler(post('/x?event=ev6', { action: 'dupr-club', playerId: 'p9', status: 'verified' }))).json();
  assert.equal(v.duprClub, 'verified');
  assert.equal((await D.getDirectory()).p9.duprClub, 'verified');
  const view = await (await manageHandler(get('/x?event=ev6'))).json();
  assert.equal(view.roster.find(p => p.playerId === 'p9').duprClub, 'verified');

  // their own later "confirmed" never downgrades the admin's check
  await D.setPlayerInfo('p9', { duprClub: 'confirmed' });
  assert.equal((await D.getDirectory()).p9.duprClub, 'verified');

  // next DUPR ladder: no box needed, and the entry starts verified
  await seedLadder('ev7', { duprRated: true });
  WHO = { admin: null, player: { id: 'p9', email: 'new@example.com', name: 'New Player' } };
  r = await signupHandler(post('/x?event=ev7', { paymentMethod: 'free', duprId: 'ABC123' }));
  assert.equal(r.status, 200);
  s = await L.getSignups('ev7');
  assert.equal(s.roster.find(p => p.playerId === 'p9').duprClub, 'verified');

  // admin can take it back
  WHO = { admin: 'boss@x.co', player: null };
  await manageHandler(post('/x?event=ev7', { action: 'dupr-club', playerId: 'p9', status: '' }));
  assert.equal((await D.getDirectory()).p9.duprClub, '');
  WHO = { admin: null, player: null };
});

test('the portal feed carries updates and club status for a signed-up player only', { skip }, async () => {
  const ev = await seedLadder('ev8', { duprRated: true });
  await M.sendLadderMessage({ event: ev, subject: 'Time moved', bodyHtml: '<p>Now 7 PM.</p>', audience: { roster: true }, kind: 'update' });
  WHO = { admin: null, player: { id: 'p1', email: 'ana@example.com', name: 'Ana Ruiz' } };
  const mine = await (await eventsHandler(get('/x'))).json();
  const reg = mine.registered.find(e => e.id === 'ev8');
  assert.equal(reg.updates.length, 1);
  assert.equal(reg.updates[0].subject, 'Time moved');
  assert.equal(reg.duprRated, true);
  WHO.player = { id: 'p77', email: 'stranger@example.com', name: 'Stranger' };
  const other = await (await eventsHandler(get('/x'))).json();
  assert.ok(!other.registered.some(e => e.id === 'ev8'));
  assert.ok(!JSON.stringify(other).includes('Now 7 PM'));
  WHO = { admin: null, player: null };
});

test('an organizer edit keeps the admin-only settings (DUPR-rated, format, notes)', { skip }, async () => {
  await seedLadder('ev9', { ownerEmail: 'org@x.co', duprRated: true, format: 'fixed-partner', description: 'Bring water', adminNotes: 'keys in box' });
  await store(ORG_STORE).setJSON('org/org@x.co.json', { email: 'org@x.co', status: 'active', name: 'Org' });
  WHO = { admin: null, player: { id: 'porg', email: 'org@x.co', name: 'Org' } };
  const r = await orgSaveHandler(post('/x', { id: 'ev9', name: 'Friday Ladder', date: soon(10), startTime: '6:30 PM', endTime: '8:00 PM', place: 'South End', courts: 3, courtNames: ['A', 'B', 'C'] }));
  assert.equal(r.status, 200);
  const res = await r.json();
  assert.equal(res.event.duprRated, true);
  assert.equal(res.event.format, 'fixed-partner');
  assert.equal(res.event.description, 'Bring water');
  assert.equal(res.event.adminNotes, 'keys in box');
  assert.deepEqual(res.changes.map(c => c.field), ['startTime']);
  // and the organizer can message their own ladder, but not someone else's
  MAIL.length = 0;
  const sent = await (await msgHandler(post('/x', { eventId: 'ev9', message: 'Start is now 6:30.', kind: 'update', audience: { roster: true, waitlist: true, only: 'dupr-unverified' } }))).json();
  assert.equal(sent.sent, 3);                       // `only` is admin-only, so it is ignored here
  assert.equal(MAIL[0].reply_to, 'org@x.co');
  assert.equal((await msgHandler(post('/x', { eventId: 'ev4', message: 'not mine' }))).status, 403);
  WHO = { admin: null, player: null };
});
