// tests/drop-render.test.js
//
// Renders public/drop.html's article pipeline against a realistic record and
// asserts the photo-led layout without losing any of the performers rail.
//
// The page script is a plain IIFE that builds one HTML string and assigns it to
// #dp-root, so we can run it under a minimal DOM stub instead of pulling in
// jsdom — the render path is pure string concatenation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Fixture: mirrors the shape public-drop.js returns, with the rail populated
//    exactly as Week 5 had it (2 POTW, Team of the Week, 3 metric tabs × M/F).
const P = (name, teamName, w, l, dsr, diff, ps) => ({ playerId: null, name, teamName, w, l, dsr, diff, ps });

const RECORD = {
  circuit: 'I',
  week: 6,
  kicker: 'The Drop · Week 6',
  title: 'Rivalry Week ends in three straight sweeps',
  dek: 'Every match finished 4-0 and every match finished 9-3 on games.',
  byline: 'By The Society Desk',
  readMins: 6,
  leadHtml: '<p>Block one.</p><p>Block two.</p><blockquote><p>The pull quote.</p></blockquote><p>Block four.</p><p>Block five.</p><p>Block six.</p>',
  cover: null, // exercises the gallery[0] hero fallback
  teamReports: [
    { team: 'ZERO ZERO TWO', blurb: 'Unbeaten across twelve rounds.' },
    { team: 'Smash Society', blurb: 'Second on 15 match points.' },
    { team: 'Big Dink Energy', blurb: 'Third by a single match point.' },
    { team: "K'CHN", blurb: 'Fourth, and better than that.' },
    { team: 'What the Dink?!', blurb: 'Best two-week stretch in the league.' },
    { team: 'Timog Cal', blurb: 'Still turning up in full.' },
  ],
  storylines: [
    { tag: 'The Bracket', tagKind: 'note', title: 'One match point', html: '<p>Body A.</p>', chips: [{ label: '3rd', value: 'BDE 14' }], image: { id: 'img_s1', caption: 'Cap S1', credit: null, focal: { x: 30, y: 20 } } },
    { tag: 'Perfect Season', tagKind: 'streak', title: 'Twelve rounds', html: '<p>Body B.</p>', chips: [], image: { id: 'img_s2', caption: null, credit: null, focal: null } },
    { tag: 'Late Bloom', tagKind: 'riser', title: 'A fortnight', html: '<p>Body C.</p>', chips: [], image: null }, // photoless storyline
  ],
  gallery: [
    { id: 'img_g0', caption: 'Hero shot', credit: 'R. Hak', focal: { x: 62, y: 18 } },
    { id: 'img_g1', caption: 'Inline one', credit: null, focal: null },
    { id: 'img_g2', caption: 'Inline two', credit: null, focal: { x: 10, y: 90 } },
    { id: 'img_g3', caption: null, credit: null, focal: null },
    { id: 'img_g4', caption: null, credit: null, focal: null },
  ],
  performers: {
    potw: {
      men: { ...P('Eli Henry', 'Big Dink Energy', 4, 0, 91.1, 23, 44), isChef: true },
      women: { ...P('Shay C', 'ZERO ZERO TWO', 4, 0, 92.4, 28, 44), isChef: true },
    },
    teamOfWeek: { name: 'ZERO ZERO TWO', emoji: '🎯', record: '22–2', note: 'Unbeaten.' },
    topPerformers: {
      men: {
        dsr: [P('Anthony B', 'ZERO ZERO TWO', 4, 0, 87.9, 13, 44), P('Patrick', "K'CHN", 3, 0, 87.8, 14, 33)],
        diff: [P('Richard Hak', 'Big Dink Energy', 2, 1, 56.5, 15, 32)],
        pts: [P('Kyle U', 'ZERO ZERO TWO', 2, 2, 46.1, 12, 41)],
      },
      women: {
        dsr: [P('Vernice Carag', "K'CHN", 3, 0, 91.4, 23, 33), P('Elaine Dodson', 'What the Dink?!', 3, 0, 89.2, 16, 33)],
        diff: [P('Kaithlyn R', 'ZERO ZERO TWO', 3, 1, 65.7, 25, 43)],
        pts: [P('Lara P', 'ZERO ZERO TWO', 4, 0, 89.1, 19, 44)],
      },
    },
    climbers: [],
    risers: [],
  },
  publishedAt: '2026-07-21T05:00:00.000Z',
};

// Players aggregate — drives the live-computed Top Movers band.
const PLAYERS = {
  a: { playerId: 'a', name: 'Richard Hak', teamName: 'Big Dink Energy', gender: 'M', composite: 66.7, rankDelta: 8, photoUrl: null },
  b: { playerId: 'b', name: 'Kyle U', teamName: 'ZERO ZERO TWO', gender: 'M', composite: 74.4, rankDelta: 4, photoUrl: null },
  c: { playerId: 'c', name: 'Shay C', teamName: 'ZERO ZERO TWO', gender: 'F', composite: 76.9, rankDelta: 2, photoUrl: null },
  d: { playerId: 'd', name: 'Amita Parikh', teamName: 'What the Dink?!', gender: 'F', composite: 41.0, rankDelta: 2, photoUrl: null },
};

// ── Minimal DOM stub: enough surface for the page script to run to completion.
function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', src: '', className: '',
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, appendChild() {}, remove() {},
    querySelector: () => makeEl('x'), querySelectorAll: () => [],
    closest: () => null, scrollIntoView() {},
  };
}

async function renderFixture(record, players) {
  const html = readFileSync(join(ROOT, 'public', 'drop.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)];
  const code = scripts[scripts.length - 1][1]; // the page script

  const els = { 'dp-root': makeEl('dp-root'), 'dp-weekpick': makeEl('dp-weekpick'), 'dp-lightbox': makeEl('dp-lightbox') };
  const document = {
    _title: '',
    get title() { return this._title; }, set title(v) { this._title = v; },
    getElementById: (id) => els[id] || makeEl(id),
    addEventListener() {}, querySelector: () => makeEl('x'), querySelectorAll: () => [],
    createElement: () => makeEl('new'), body: makeEl('body'),
  };

  const routes = {
    'public-drop?week': { drop: record },
    'view=index': { weeks: [{ week: 5 }, { week: 6 }] },
    'view=players': { players },
    'public-standings': { divisions: {} },
    'public-teams': { teams: [] },
  };
  const fetchStub = (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(key ? routes[key] : null) });
  };

  // entity-cards.js supplies DSEntity in production; the page assumes it exists.
  const DSEntity = {
    teamHref: (n) => '/team?id=' + encodeURIComponent(n),
    playerHref: (n, t) => '/player?team=' + encodeURIComponent(t || '') + '&name=' + encodeURIComponent(n),
    linkify: (h) => h,
    buildIndex: () => ({ teams: [], players: [] }),
    mount() {},
  };

  const sandbox = {
    document,
    window: { DSEntity },
    location: { search: '?week=6' },
    fetch: fetchStub,
    URLSearchParams,
    console,
  };

  // eslint-disable-next-line no-new-func
  const run = new Function(...Object.keys(sandbox), code);
  run(...Object.values(sandbox));

  // Let the stubbed fetch promise chain settle.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));

  return els['dp-root'].innerHTML;
}

test('renders the article without losing any performers-rail content', async () => {
  const out = await renderFixture(RECORD, PLAYERS);
  assert.ok(out.length > 500, 'expected a rendered article');

  // Players of the Week — both, with their stats.
  assert.match(out, /Players of the Week/);
  assert.match(out, /Eli Henry/);
  assert.match(out, /Shay C/);
  assert.match(out, /91\.1/);
  assert.match(out, /92\.4/);

  // Team of the Week.
  assert.match(out, /Team of the Week/);
  assert.match(out, /22–2/);

  // Top Performers — all three metric tabs, men and women.
  assert.match(out, /Top Performers/);
  for (const k of ['dsr', 'diff', 'pts']) assert.match(out, new RegExp(`data-tab="${k}"`), `missing ${k} panel`);
  assert.match(out, /Anthony B/);
  assert.match(out, /Vernice Carag/);
  assert.match(out, /Richard Hak/);   // diff tab
  assert.match(out, /Kaithlyn R/);    // diff tab, women
  assert.match(out, /Kyle U/);        // pts tab
  assert.match(out, /Lara P/);        // pts tab, women

  // Top Climbers — promoted to its own band, still computed live.
  assert.match(out, /Top Climbers/);
  assert.match(out, /data-tab="moving"/);
  assert.match(out, /Top Movers/);

  // Around the League — every team survives.
  for (const t of ['ZERO ZERO TWO', 'Smash Society', 'Big Dink Energy', "K'CHN", 'What the Dink?!', 'Timog Cal']) {
    assert.ok(out.includes(t), `missing team ${t}`);
  }

  // Every storyline renders.
  assert.match(out, /One match point/);
  assert.match(out, /Twelve rounds/);
  assert.match(out, /A fortnight/);
});

test('hero falls back to the first gallery photo when no cover is set', async () => {
  const out = await renderFixture(RECORD, PLAYERS);
  assert.match(out, /class="dp-hero"/);
  assert.match(out, /drop-photo-serve\?id=img_g0/);
  // ...and the hero honours its focal point rather than centring blindly.
  assert.match(out, /id=img_g0[^>]*object-position:62% 18%/);
});

test('a cover photo takes precedence over the gallery', async () => {
  const withCover = { ...RECORD, cover: { id: 'img_cov', caption: 'Cover', credit: null, focal: { x: 40, y: 25 } } };
  const out = await renderFixture(withCover, PLAYERS);
  assert.match(out, /class="dp-hero"[\s\S]{0,200}img_cov/);
  assert.match(out, /object-position:40% 25%/);
});

test('gallery photos are woven into the lead copy, not stacked after it', async () => {
  const out = await renderFixture(RECORD, PLAYERS);
  const lead = out.slice(out.indexOf('class="lead"'), out.indexOf('gallery-sec'));
  assert.match(lead, /class="dp-float"/, 'expected a right-floated photo inside the lead');
  assert.match(lead, /class="dp-float left land"/, 'expected a left-floated photo further down the lead');
  // The float must land between paragraphs, not before the first one.
  assert.ok(lead.indexOf('<p>Block one.</p>') < lead.indexOf('dp-float'), 'photo should follow the opening paragraph');
});

test('photos without a focal point centre, and focal points are applied', async () => {
  const out = await renderFixture(RECORD, PLAYERS);
  assert.match(out, /id=img_g1[^>]*object-position:50% 50%/, 'unset focal should centre');
  assert.match(out, /id=img_g2[^>]*object-position:10% 90%/, 'set focal should apply');
  assert.match(out, /id=img_s1[^>]*object-position:30% 20%/, 'storyline focal should apply');
});

test('Week in Pictures shows the whole gallery and sits before Around the League', async () => {
  const out = await renderFixture(RECORD, PLAYERS);
  assert.match(out, /Week in Pictures/);
  assert.match(out, /5 photos/);
  for (let i = 0; i < 5; i++) assert.ok(out.includes(`img_g${i}`), `gallery photo ${i} missing from mosaic`);
  assert.ok(out.indexOf('Week in Pictures') < out.indexOf('Around the League'), 'gallery should precede Around the League');
  assert.ok(out.indexOf('Week in Pictures') < out.indexOf('Also This Week'), 'gallery should precede the storylines');
});

test('storylines alternate sides and photoless ones run full width', async () => {
  const out = await renderFixture(RECORD, PLAYERS);
  assert.match(out, /class="story"/);        // first, photo right
  assert.match(out, /class="story flip"/);   // second, photo left
  assert.match(out, /class="story nophoto"/); // third has no image
});

test('a record with no photos at all still renders the full article', async () => {
  const bare = { ...RECORD, cover: null, gallery: [], storylines: RECORD.storylines.map((s) => ({ ...s, image: null })) };
  const out = await renderFixture(bare, PLAYERS);
  assert.ok(!out.includes('dp-hero'), 'no hero without photos');
  assert.ok(!out.includes('gallery-sec'), 'no gallery section without photos');
  assert.match(out, /Players of the Week/);
  assert.match(out, /Around the League/);
  assert.match(out, /Also This Week/);
  assert.match(out, /class="story nophoto"/);
});

test('a record with no performers still renders the editorial', async () => {
  const out = await renderFixture({ ...RECORD, performers: null }, {});
  assert.ok(!out.includes('Players of the Week'));
  assert.ok(!out.includes('Top Performers'));
  assert.match(out, /Around the League/);
  assert.match(out, /Rivalry Week ends in three straight sweeps/);
});
