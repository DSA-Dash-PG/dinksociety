// node --test tests/team-story.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUESTIONS, sanitizeAnswers, answeredCount, publicStory, signStoryToken, verifyStoryToken, storyUrl } from '../netlify/functions/lib/team-story.js';

test('question keys are unique and every chip/select question has options', () => {
  const keys = QUESTIONS.map(q => q.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const q of QUESTIONS) {
    if (q.type === 'chips' || q.type === 'select') assert.ok(Array.isArray(q.options) && q.options.length >= 2, q.key);
    else assert.ok(q.max > 0, q.key + ' needs a max');
  }
});

test('sanitizeAnswers keeps known keys, trims, caps, drops empties and unknowns', () => {
  const out = sanitizeAnswers({
    intro: '  We are   the <b>Hitters</b>.\r\n\r\n\r\n\r\nSee you Thursday.  ',
    style: 'x'.repeat(500),
    bogus: 'nope',
    ritual: '   ',
    courts: 'SBTC\u0007 and the park',
  });
  assert.equal(out.intro, 'We are the <b>Hitters</b>.\n\nSee you Thursday.');
  assert.equal(out.style.length, 80);
  assert.equal(out.bogus, undefined);
  assert.equal(out.ritual, undefined);
  assert.equal(out.courts, 'SBTC and the park');
});

test('chips must come from the options; multi keeps order, de-dupes; select is a single option', () => {
  const out = sanitizeAnswers({
    how_met: ['Friends', 'Aliens', 'Coworkers', 'Friends'],
    when: 'Saturday',
    since: '1–2 years',
    rival: ['not', 'an', 'array'],
  });
  assert.deepEqual(out.how_met, ['Friends', 'Coworkers']);
  assert.deepEqual(out.when, ['Saturday']);
  assert.equal(out.since, '1–2 years');
  assert.equal(sanitizeAnswers({ since: 'Forever' }).since, undefined);
  assert.equal(sanitizeAnswers({ how_met: ['Aliens'] }).how_met, undefined);
  assert.equal(typeof out.rival, 'string');
});

test('answeredCount and publicStory follow questionnaire order and skip blanks', () => {
  const team = { name: 'Happy Hour Hitters', story: { answers: { rival: 'Big Dink Energy', intro: 'Hi', when: [] , zzz: 'ignored' }, updatedAt: '2026-10-30T19:00:00Z' } };
  assert.equal(answeredCount(team.story), 3);
  const pub = publicStory(team);
  assert.deepEqual(pub.items.map(i => i.key), ['intro', 'rival']);
  assert.equal(pub.items[1].label, QUESTIONS.find(q => q.key === 'rival').label);
  assert.equal(pub.updatedAt, '2026-10-30T19:00:00Z');
  assert.equal(publicStory({ name: 'x' }), null);
  assert.equal(publicStory({ name: 'x', story: { answers: {} } }), null);
});

test('story token round-trips, binds the email, and rejects tampering', () => {
  const tok = signStoryToken({ teamId: 'team_abc', email: 'Cap@Example.com' });
  assert.deepEqual(verifyStoryToken(tok), { teamId: 'team_abc', email: 'cap@example.com' });
  const [payload, sig] = tok.split('.');
  assert.equal(verifyStoryToken(payload + '.' + sig.slice(0, -2) + 'xx'), null);
  assert.equal(verifyStoryToken('garbage'), null);
  assert.equal(verifyStoryToken(''), null);
  // A different team's payload with this signature does not verify.
  const other = signStoryToken({ teamId: 'team_def', email: 'cap@example.com' }).split('.')[0];
  assert.equal(verifyStoryToken(other + '.' + sig), null);
  assert.equal(storyUrl('https://dinksociety.app/', tok), 'https://dinksociety.app/team-story?t=' + encodeURIComponent(tok));
});
