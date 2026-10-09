// tests/desk-inbox.test.js
//
// The Desk inbox: a scheduled write-up task files a draft, the admins get a
// review email, and one tap on its Approve link publishes.
//
// The parsing half is pure. The rest runs the real endpoints against an
// in-memory stand-in for Netlify Blobs and a fake mail client, so it needs:
//
//   node --test --experimental-test-module-mocks tests/desk-inbox.test.js
//
// Without that flag those tests skip themselves rather than failing the suite.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TEMPLATE = readFileSync(new URL('./fixtures/drop-template-week-9.md', import.meta.url), 'utf8');

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
class FakeResend { constructor() { this.emails = { send: async (p) => { MAIL.push(p); return { data: { id: 'm' + MAIL.length } }; } }; } }
const FETCHES = [];

const KEY = 'k'.repeat(40);
const url = (p) => new URL(p, import.meta.url).href;
let ADMIN = null;
let skip = false;
let I, inboxHandler, approveHandler, senderHandler, Drop, Recap;
try {
  process.env.RESEND_API_KEY = 'test';
  process.env.SITE_URL = 'https://example.test';
  process.env.ADMIN_EMAILS = 'boss@example.test';
  process.env.DESK_INBOX_KEY = KEY;
  delete process.env.EMAIL_ADMIN_BCC;
  mock.module('@netlify/blobs', { namedExports: { getStore: (arg) => store(typeof arg === 'string' ? arg : arg.name) } });
  mock.module('resend', { namedExports: { Resend: FakeResend } });
  mock.module(url('../netlify/functions/lib/auth.js'), { namedExports: {
    verifyAdminSession: async () => ADMIN ? { valid: true, payload: { email: ADMIN } } : { valid: false, error: 'Unauthorized' },
    verifyCaptainSession: async () => ({ valid: false }),
    verifyPlayerSession: async () => ({ valid: false }),
    unauthResponse: (e) => new Response(JSON.stringify({ error: e || 'Unauthorized' }), { status: 401 }),
  } });
  globalThis.fetch = async (u, opts) => { FETCHES.push({ url: String(u), opts }); return new Response('', { status: 202 }); };
  I = await import('../netlify/functions/lib/desk-inbox.js');
  Drop = await import('../netlify/functions/lib/drop.js');
  Recap = await import('../netlify/functions/lib/ladder-recap.js');
  ({ default: inboxHandler } = await import('../netlify/functions/desk-inbox.js'));
  ({ default: approveHandler } = await import('../netlify/functions/desk-approve.js'));
  ({ default: senderHandler } = await import('../netlify/functions/admin-broadcast-email-background.js'));
} catch (e) {
  skip = 'needs --experimental-test-module-mocks (' + (e && e.message ? e.message.slice(0, 120) : e) + ')';
}

const BASE = 'https://example.test/.netlify/functions';
const fileMd = (qs, md, key = KEY) => inboxHandler(new Request(`${BASE}/desk-inbox?${qs}`, { method: 'POST', headers: { 'Content-Type': 'text/markdown', 'x-desk-key': key }, body: md }));
const fileJson = (body, key = KEY) => inboxHandler(new Request(`${BASE}/desk-inbox`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-desk-key': key }, body: JSON.stringify(body) }));
const approveLinkIn = (html) => (html.match(/desk-approve\?t=([a-f0-9]{48})/) || [])[1];
const viewTokenIn = (html) => (html.match(/preview=1&t=([a-f0-9]{48})/) || [])[1];
const tap = (t) => approveHandler(new Request(`${BASE}/desk-approve?t=${t}`));
const confirm = (t) => approveHandler(new Request(`${BASE}/desk-approve`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 't=' + t }));

// ═══════════ pure ═══════════

test('parseDropTemplate: every composer field comes out of the template', { skip }, () => {
  const t = I.parseDropTemplate(TEMPLATE);
  assert.equal(t.kicker, 'The Drop · Week 9');
  assert.equal(t.byline, 'By The Society Desk');
  assert.equal(t.title, 'Week Nine: The Fixture Team Wins a Match Nobody Timed Correctly');
  assert.match(t.dek, /^A test headline, a test dek/);          // "Dek (sub-headline)" must not land in the headline
  assert.equal(t.lead.split(/\n{2,}/).length, 4);
  assert.equal(I.parseTeamReports(t.around).length, 3);
  assert.equal(t.storylines.length, 3);
  assert.deepEqual(t.storylines.map(s => s.type), ['title', 'riser', 'note']);
  assert.deepEqual(t.storylines.map(s => s.team), ['Alpha Squad', 'Charlie Crew', '']);
  assert.equal(t.storylines[0].tag, 'Four clear');
  assert.equal(t.storylines[0].title, 'Alpha Squad: six players, six 4–0 nights');
  assert.match(t.storylines[0].body, /\*\*Mixed is no longer the question\.\*\*/);
  assert.equal(I.parseChips(t.storylines[0].chips).length, 3);
  assert.match(t.notes, /^\*\*Notes for Richard/);
  assert.match(t.notes, /implausible/);
  assert.equal(I.editionFromTitle(t.h1), 'week-9');
});

test('editionFromTitle: recap, preview and championship preview', { skip }, () => {
  assert.equal(I.editionFromTitle('The Drop · Week 5 Preview — Season 2'), 'week-5-preview');
  assert.equal(I.editionFromTitle('The Drop · Championship Preview — Season 2'), 'championship-preview');
  assert.equal(I.editionFromTitle('The Drop · Week 12 — Season 2'), 'week-12');
  assert.equal(I.editionFromTitle('Something else'), null);
});

test('mdToHtml: paragraphs, bold, and a "> " line becomes the pull-quote', { skip }, () => {
  const html = I.mdToHtml('One **bold** line.\n\n> The quote & more.\n\nLast <b>raw</b>.');
  assert.equal(html, '<p>One <b>bold</b> line.</p><blockquote>The quote &amp; more.</blockquote><p>Last &lt;b&gt;raw&lt;/b&gt;.</p>');
});

test('ladderHtml: only the tags the recap email renders survive', { skip }, () => {
  const html = I.ladderHtml('<p onclick="x()">Hi <i>there</i> <a href="https://x.test">link</a></p><script>alert(1)</script><blockquote class="q">Q</blockquote>');
  assert.equal(html, '<p>Hi <em>there</em> link</p><blockquote>Q</blockquote>');
});

// ═══════════ the inbox endpoint ═══════════

test('inbox: no key → nothing filed; a bare GET only says it is deployed', { skip }, async () => {
  const r = await fileMd('circuit=II&edition=week-9', TEMPLATE, 'wrong');
  assert.equal(r.status, 401);
  assert.equal(await Drop.getDrop('II', 'week-9'), null);
  const ping = await (await inboxHandler(new Request(`${BASE}/desk-inbox`))).json();
  assert.deepEqual(ping, { ok: true, service: 'desk-inbox' });
});

test('inbox: the title line and the edition must agree', { skip }, async () => {
  const r = await fileMd('circuit=II&edition=week-8', TEMPLATE);
  assert.equal(r.status, 422);
  assert.equal((await r.json()).reason, 'edition-mismatch');
  assert.equal(await Drop.getDrop('II', 'week-8'), null);
});

test('inbox: an empty template is refused, not filed', { skip }, async () => {
  const blank = TEMPLATE.replace(/Week Nine: The Fixture Team Wins a Match Nobody Timed Correctly/, '<headline — spell out the week number>');
  const r = await fileMd('circuit=II&edition=week-9', blank);
  assert.equal(r.status, 422);
  assert.ok((await r.json()).missing.includes('lead headline'));
});

test('inbox: files the draft, emails the admins, and never hands the approve link back', { skip }, async () => {
  MAIL.length = 0;
  const r = await fileMd('circuit=II&edition=week-9', TEMPLATE);
  const out = await r.json();
  assert.equal(r.status, 200);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'draft');
  assert.equal(out.storylines, 3);
  assert.equal(out.emailed, true);
  assert.ok(!/[a-f0-9]{48}/.test(JSON.stringify(out)), 'no token in the response');

  const rec = await Drop.getDrop('II', 'week-9');
  assert.equal(rec.status, 'draft');
  assert.equal(rec.updatedBy, 'desk-inbox');
  assert.equal(rec.generatedBy, 'auto');
  assert.equal(rec.kicker, 'The Drop · Week 9');
  assert.match(rec.leadHtml, /<blockquote>One team was outscored by 13 and won 3–1\. Wide open has a sense of humor\.<\/blockquote>/);
  assert.match(rec.leadHtml, /<b>Both<\/b> jerseys/);
  assert.equal(rec.teamReports.length, 3);
  assert.equal(rec.storylines[0].team, 'Alpha Squad');
  assert.equal(rec.storylines[0].tagKind, 'title');
  assert.deepEqual(rec.storylines[1].chips, [{ label: 'Match', value: '3–1' }, { label: 'Close games', value: '6–1 Thursday' }]);

  assert.equal(MAIL.length, 1);
  assert.deepEqual(MAIL[0].to, ['boss@example.test']);
  assert.match(MAIL[0].subject, /^Approve: The Drop · Week 9 — Week Nine/);
  assert.ok(approveLinkIn(MAIL[0].html));
  assert.ok(viewTokenIn(MAIL[0].html));
  assert.match(MAIL[0].html, /Notes for you/);
  assert.match(MAIL[0].html, /implausible/);
});

test('inbox: the same file again is a no-op; a different one waits its turn', { skip }, async () => {
  MAIL.length = 0;
  const same = await (await fileMd('circuit=II&edition=week-9', TEMPLATE)).json();
  assert.equal(same.unchanged, true);
  const other = await fileMd('circuit=II&edition=week-9', TEMPLATE.replace('Six dressed', 'Seven dressed'));
  assert.equal(other.status, 409);
  assert.equal((await other.json()).reason, 'already-pending');
  assert.equal(MAIL.length, 0);
  const list = await (await inboxHandler(new Request(`${BASE}/desk-inbox?kind=drop&circuit=II`, { headers: { 'x-desk-key': KEY } }))).json();
  assert.deepEqual(list.items.map(i => [i.edition, i.status]), [['week-9', 'pending']]);
});

test('inbox: a draft an admin has edited is left alone', { skip }, async () => {
  await Drop.saveDraft('II', 'week-3', { title: 'Hand written', leadHtml: '<p>Mine.</p>', storylines: [] }, 'boss@example.test');
  const md = TEMPLATE.replace(/Week 9/g, 'Week 3');
  const r = await fileMd('circuit=II&edition=week-3', md);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).reason, 'edited-in-admin');
  assert.equal((await Drop.getDrop('II', 'week-3')).title, 'Hand written');
});

test('inbox: replacing a filed draft keeps photos an admin attached', { skip }, async () => {
  const cur = await Drop.getDrop('II', 'week-9');
  cur.storylines[1].images = [{ id: 'img_keep', caption: 'Kept' }];
  await Drop.saveDraft('II', 'week-9', { ...cur, cover: { id: 'img_cover' } }, 'boss@example.test');
  MAIL.length = 0;
  const r = await fileJson({ kind: 'drop', circuit: 'II', edition: 'week-9', replace: true, markdown: TEMPLATE.replace('Six dressed', 'Seven dressed') });
  assert.equal(r.status, 200);
  const rec = await Drop.getDrop('II', 'week-9');
  assert.equal(rec.cover.id, 'img_cover');
  assert.equal(rec.storylines.find(s => s.team === 'Charlie Crew').images[0].id, 'img_keep');
  assert.match(rec.teamReports[0].blurb, /^Seven dressed/);
  assert.equal(MAIL.length, 1);
});

// ═══════════ approve ═══════════

test('approve: the email link shows a page; only the POST publishes', { skip }, async () => {
  await store('teams').setJSON('team/t1.json', { id: 't1', name: 'Alpha Squad', circuit: 'II', captainEmail: 'cap@example.test',
    roster: [{ id: 'p1', name: 'Ana Ruiz', email: 'ana@example.test' }] });
  await store('teams').setJSON('team/old.json', { id: 'old', name: 'Season One Team', circuit: 'I', captainEmail: 'old@example.test', roster: [] });

  const mail = MAIL[MAIL.length - 1];
  const t = approveLinkIn(mail.html), v = viewTokenIn(mail.html);

  // The preview token reads the draft and cannot approve.
  const pv = await (await approveHandler(new Request(`${BASE}/desk-approve?view=json&t=${v}`))).json();
  assert.equal(pv.record.title, 'Week Nine: The Fixture Team Wins a Match Nobody Timed Correctly');
  assert.equal(pv.preview, true);
  assert.match(await (await confirm(v)).text(), /Link expired/);
  assert.equal((await Drop.getDrop('II', 'week-9')).status, 'draft');

  // Fetching the approve link changes nothing (a scanner or preview can do this).
  const page = await tap(t);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<form id="f" method="POST"/);
  assert.match(html, /Approve &amp; publish/);
  assert.equal((await Drop.getDrop('II', 'week-9')).status, 'draft');
  await tap(t);
  assert.equal((await Drop.getDrop('II', 'week-9')).status, 'draft');

  // The POST does it.
  FETCHES.length = 0;
  const done = await confirm(t);
  const doneHtml = await done.text();
  assert.match(doneHtml, /It&rsquo;s live/);
  assert.match(doneHtml, /Posted to 1 team portal and emailing 2 players now\./);
  const rec = await Drop.getDrop('II', 'week-9');
  assert.equal(rec.status, 'published');
  assert.ok(rec.publishedAt && rec.broadcastId);

  // Season-scoped broadcast, with a one-time kick token the sender will accept.
  const bc = await store('broadcasts').get(`broadcast/${rec.broadcastId}.json`, { type: 'json' });
  assert.deepEqual(bc.teamIds, ['t1']);
  assert.deepEqual(bc.recipientsByTeam.t1.sort(), ['ana@example.test', 'cap@example.test']);
  assert.equal(bc.emailStatus, 'queued');
  assert.equal(FETCHES.length, 1);
  assert.match(FETCHES[0].url, /admin-broadcast-email-background$/);
  assert.equal(FETCHES[0].opts.headers['x-broadcast-kick'], bc.kickToken);

  // A second tap or a refresh cannot publish or notify twice.
  FETCHES.length = 0;
  assert.match(await (await confirm(t)).text(), /Already live/);
  assert.match(await (await tap(t)).text(), /Already live/);
  assert.equal(FETCHES.length, 0);

  // And the inbox now refuses a late re-file of a published edition.
  const late = await fileMd('circuit=II&edition=week-9', TEMPLATE);
  assert.equal((await late.json()).reason, 'already-published');
});

test('sender: runs for the kick token on its own record, and for nothing else', { skip }, async () => {
  const rec = await Drop.getDrop('II', 'week-9');
  const key = `broadcast/${rec.broadcastId}.json`;
  const kick = (await store('broadcasts').get(key, { type: 'json' })).kickToken;
  const call = (k) => senderHandler(new Request(`${BASE}/admin-broadcast-email-background`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(k ? { 'x-broadcast-kick': k } : {}) }, body: JSON.stringify({ broadcastId: rec.broadcastId }) }));

  assert.equal((await call(null)).status, 401);
  assert.equal((await call('f'.repeat(48))).status, 401);
  assert.equal((await store('broadcasts').get(key, { type: 'json' })).emailStatus, 'queued');

  MAIL.length = 0;
  const ok = await call(kick);
  assert.equal(ok.status, 200);
  const after = await store('broadcasts').get(key, { type: 'json' });
  assert.equal(after.emailStatus, 'done');
  assert.equal(after.emailed, 2);
  assert.equal(after.kickToken, null);
  assert.equal(MAIL.length, 2);
  assert.equal((await call(kick)).status, 401);                  // the token died with the send
});

// ═══════════ ladder recap ═══════════

test('ladder: the write-up waits for approval, then saves and sends', { skip }, async () => {
  await Recap.saveRecapDraft('ev12345', {
    generatedBy: 'templated',
    event: { id: 'ev12345', name: "King's Court #3", date: '2026-10-11', type: 'mens' },
    recap: { title: 'Templated title', dek: '8 players', html: '<p>Templated.</p>', seasonNote: '', podium: [], minis: {} },
    players: { p1: { name: 'Ana Ruiz', rank: 1, count: 8, w: 6, l: 1, diff: 20, dr: 70, delta: 0, hi: 'Nice work, Ana.', sub: '', story: [], call: null, streak: null } },
    recipients: [{ playerId: 'p1', name: 'Ana Ruiz', email: 'ana@example.test' }],
  });

  MAIL.length = 0;
  const body = { kind: 'ladder-recap', eventId: 'ev12345', title: 'Ana R. Takes the Throne',
    dek: 'Six wins, one loss, and a point differential that did the talking.',
    html: '<p>Ana R. won six of seven on Sunday and spent most of the night on King Court, which is where a plus twenty differential tends to put a person.</p><p>Everyone else found a bright spot too, and the fixture is pleased to report it without checking a single score.</p>',
    seasonNote: 'That is two nights running for Ana.' };
  const r = await fileJson(body);
  const out = await r.json();
  assert.equal(r.status, 200);
  assert.equal(out.recipients, 1);
  assert.ok(!/[a-f0-9]{48}/.test(JSON.stringify(out)));

  // Filed, emailed for review, and NOT yet on the recap.
  assert.equal(MAIL.length, 1);
  assert.deepEqual(MAIL[0].to, ['boss@example.test']);
  assert.match(MAIL[0].subject, /^Approve: ladder recap — King's Court #3/);
  assert.match(MAIL[0].html, /Approve &amp; send to 1 player/);
  assert.equal((await Recap.getRecap('ev12345')).recap.title, 'Templated title');
  assert.equal((await (await fileJson(body)).json()).unchanged, true);

  const t = approveLinkIn(MAIL[0].html);
  await tap(t);
  assert.equal((await Recap.getRecap('ev12345')).recap.title, 'Templated title');

  MAIL.length = 0;
  const done = await (await confirm(t)).text();
  assert.match(done, /Sent &#10003;/);
  const rec = await Recap.getRecap('ev12345');
  assert.equal(rec.recap.title, 'Ana R. Takes the Throne');
  assert.equal(rec.recap.seasonNote, 'That is two nights running for Ana.');
  assert.equal(rec.status, 'sent');
  assert.equal(MAIL.length, 1);
  assert.equal(MAIL[0].to, 'ana@example.test');
  assert.match(MAIL[0].html, /Ana R\. Takes the Throne/);

  // Tapping again does not email the roster twice.
  MAIL.length = 0;
  assert.match(await (await confirm(t)).text(), /Already sent/);
  assert.equal(MAIL.length, 0);
  assert.equal((await (await fileJson(body)).json()).reason, 'already-approved');
});

test('ladder: a night with no recap to attach to is refused', { skip }, async () => {
  const r = await fileJson({ kind: 'ladder-recap', eventId: 'nope0000', title: 'A title', html: '<p>' + 'word '.repeat(40) + '</p>' });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).reason, 'no-recap-draft');
});
