// tests/ladder-home.test.js
// The home page's view of the ladders (lib/ladder-home.js): which ladder is
// "next" and how full it is, which finished ladder is "last", and the write-ups
// the headline rotation picks from. Blobs are replaced through `deps`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLadderHome, todayIn } from '../netlify/functions/lib/ladder-home.js';

const NOW = Date.parse('2026-10-09T17:00:00-07:00');   // Fri Oct 9, 5pm PT

const ev = (id, date, over = {}) => ({ id, name: 'Ladder ' + id, date, startTime: '11:00am', endTime: '1:00pm', place: 'Dink House', type: 'mens', courts: 4, capacity: 16, status: 'open', ...over });
const roster = n => ({ roster: Array.from({ length: n }, (_, i) => ({ name: 'P' + i, email: 'p' + i + '@x.test' })), waitlist: [] });
const teaser = (e, sentAt) => ({ eventId: e.id, name: e.name, date: e.date, place: e.place, type: e.type, format: 'individual', title: 'T ' + e.id, dek: 'D', url: '/ladders/recaps/' + e.id, sentAt, podium: [{ name: 'A', w: 7, l: 1 }] });

function deps({ events, signups = {}, sent = {}, previews = {}, photos = {} }) {
  return {
    listEvents: async () => events,
    getSignups: async id => signups[id] || { eventId: id, roster: [], waitlist: [] },
    recapTeaser: async e => (sent[e.id] ? teaser(e, sent[e.id]) : null),
    previews,
    photoFor: async id => photos[id] || null,
  };
}

test('todayIn gives the league-timezone date', () => {
  assert.equal(todayIn(Date.parse('2026-10-10T03:00:00Z')), '2026-10-09');   // 8pm PT the day before
});

test('next is the earliest upcoming public ladder, with how full it is and its preview', async () => {
  const events = [
    ev('past', '2026-10-01'),                                  // date gone, never finalized: not "next"
    ev('private', '2026-10-10', { visibility: 'private' }),
    ev('kc3', '2026-10-11'),
    ev('later', '2026-10-18'),
    ev('done', '2026-09-26', { status: 'final' }),
  ];
  const out = await buildLadderHome({ now: NOW, deps: deps({
    events, signups: { kc3: { eventId: 'kc3', ...roster(16), waitlist: [{ name: 'W', email: 'w@x.test' }] } },
    previews: { kc3: { url: '/ladders/previews/kc3.html', title: 'Preview', dek: 'Dek', publishedAt: '2026-10-06T11:12:00-07:00', sections: [{ label: 'The throne', id: 'the-throne' }] } },
  }) });
  assert.equal(out.next.id, 'kc3');
  assert.equal(out.next.spotsLeft, 0);
  assert.equal(out.next.rosterCount, 16);
  assert.equal(out.next.capacity, 16);
  assert.equal(out.next.waitlistCount, 1);
  assert.deepEqual(out.next.preview, { url: '/ladders/previews/kc3.html', title: 'Preview' });
  assert.equal(JSON.stringify(out).includes('@x.test'), false, 'no roster or email leaves the function');
});

test('a ladder being played stays "next" as live', async () => {
  const out = await buildLadderHome({ now: NOW, deps: deps({ events: [ev('today', '2026-10-09', { status: 'live' }), ev('kc3', '2026-10-11')] }) });
  assert.equal(out.next.id, 'today');
  assert.equal(out.next.status, 'live');
});

test('last is the newest finished ladder whose recap has been SENT', async () => {
  const events = [ev('a', '2026-09-14', { status: 'final' }), ev('b', '2026-09-26', { status: 'final' }), ev('c', '2026-10-04', { status: 'final' })];
  const out = await buildLadderHome({ now: NOW, deps: deps({ events, sent: { a: '2026-09-14T15:00:00-07:00', b: '2026-09-26T15:00:00-07:00' }, photos: { b: { id: 'ph1', fx: 40, fy: 20 } } }) });
  assert.equal(out.last.eventId, 'b', 'c has no sent recap yet, so b is the last one to show');
  assert.equal(out.last.url, '/ladders/recaps/b');
  assert.deepEqual(out.last.photo, { id: 'ph1', fx: 40, fy: 20 });
  assert.equal(out.next, null);
});

test('writeups mix sent recaps and published previews, newest first', async () => {
  const events = [ev('b', '2026-09-26', { status: 'final' }), ev('kc3', '2026-10-11'), ev('gone', '2026-10-20', { visibility: 'private' })];
  const previews = {
    kc3: { url: '/p/kc3.html', title: 'Sixteen men', dek: 'Dek', publishedAt: '2026-10-06T11:12:00-07:00', sections: [{ label: 'The throne', id: 'the-throne' }, { label: '', id: 'x' }] },
    gone: { url: '/p/gone.html', title: 'Private', publishedAt: '2026-10-08T11:00:00-07:00' },      // private ladder: never listed
    missing: { url: '/p/missing.html', title: 'No event', publishedAt: '2026-10-08T11:00:00-07:00' }, // event deleted
    future: { url: '/p/f.html', title: 'Not yet', publishedAt: '2026-10-12T11:00:00-07:00' },
  };
  const out = await buildLadderHome({ now: NOW, deps: deps({ events, sent: { b: '2026-09-26T15:00:00-07:00' }, previews }) });
  assert.deepEqual(out.writeups.map(w => w.kind + ':' + w.eventId), ['preview:kc3', 'recap:b']);
  const pv = out.writeups[0];
  assert.equal(pv.upcoming, true);
  assert.equal(pv.spotsLeft, 16);
  assert.deepEqual(pv.sections, [{ label: 'The throne', id: 'the-throne' }]);
  assert.equal(pv.courts, 4);
  assert.equal(out.writeups[1].podium[0].name, 'A');
});

test('a preview dated in the future is not a write-up yet', async () => {
  const events = [ev('kc3', '2026-10-11')];
  const out = await buildLadderHome({ now: NOW, deps: deps({ events, previews: { kc3: { url: '/p.html', title: 'T', publishedAt: '2026-10-10T09:00:00-07:00' } } }) });
  assert.deepEqual(out.writeups, []);
  assert.equal(out.next.preview.url, '/p.html', 'the strip still links a preview that exists');
});

test('nothing scheduled and nothing played is an empty answer, not an error', async () => {
  const out = await buildLadderHome({ now: NOW, deps: deps({ events: [] }) });
  assert.deepEqual(out, { next: null, last: null, writeups: [] });
});
