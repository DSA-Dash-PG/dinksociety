// tests/drop-reword.test.js
// Wording fixes on a stored Drop edition: exact phrases swap in the copy and
// nothing else on the record moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewordRecord } from '../netlify/functions/lib/drop.js';

const rec = {
  edition: 'week-3', status: 'published', publishedAt: '2026-10-02T21:14:00.000Z',
  broadcastId: 'bc_1', broadcastAt: '2026-10-02T21:14:01.000Z',
  title: 'The table has a leader',
  dek: 'Top of the table, again.',
  leadHtml: '<p>Three weeks in, the table has a leader. The table says so.</p>',
  cover: { id: 'the table', caption: 'the table' },
  teamReports: [{ teamName: 'Smash Society', blurb: 'Top of the table.' }],
  storylines: [{
    tag: 'Race', tagKind: 'title', team: 'the table', title: 'Second place in the table',
    html: '<p>In a way the table can’t show.</p>', image: { id: 'the table' },
    chips: [{ label: 'Table', value: 'top of the table' }],
  }],
  performers: { potw: { men: { name: 'the table' } } },
};

test('swaps the phrase everywhere in the copy and counts each replacement', () => {
  const { rec: out, counts } = rewordRecord(rec, [
    { from: 'the table has a leader', to: 'the standings have a leader' },
    { from: 'The table has a leader', to: 'The standings have a leader' },
    { from: 'The table says', to: 'The standings say' },
    { from: 'the table', to: 'the standings' },
  ]);
  assert.deepEqual(counts, [1, 1, 1, 5]);
  assert.equal(out.title, 'The standings have a leader');
  assert.equal(out.leadHtml, '<p>Three weeks in, the standings have a leader. The standings say so.</p>');
  assert.equal(out.teamReports[0].blurb, 'Top of the standings.');
  assert.equal(out.storylines[0].title, 'Second place in the standings');
  assert.equal(out.storylines[0].chips[0].value, 'top of the standings');
});

test('leaves photos, the team link, performers and every stamp alone', () => {
  const { rec: out } = rewordRecord(rec, [{ from: 'the table', to: 'the standings' }]);
  assert.deepEqual(out.cover, rec.cover);
  assert.deepEqual(out.storylines[0].image, rec.storylines[0].image);
  assert.equal(out.storylines[0].team, 'the table');
  assert.deepEqual(out.performers, rec.performers);
  for (const k of ['edition', 'status', 'publishedAt', 'broadcastId', 'broadcastAt']) assert.equal(out[k], rec[k]);
  assert.equal(rec.dek, 'Top of the table, again.', 'the input record is not mutated');
});

test('no usable pairs → nothing changes', () => {
  const { rec: out, counts } = rewordRecord(rec, [{ from: '', to: 'x' }, { from: 'same', to: 'same' }, null]);
  assert.deepEqual(counts, []);
  assert.deepEqual(out, rec);
});
