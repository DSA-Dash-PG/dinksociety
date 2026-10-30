// netlify/functions/lib/team-story.js
//
// The team story questionnaire: a short "who are you" form every captain fills
// in once, whose answers show up on the public team page ("Get to know …").
//
// Pure module — the question list, the answer validator and the signed link
// token. No blobs here; `team-story.js` (captain/token side), `admin-team-story.js`
// (links + send) and `public-teams.js` (public read) do the I/O.
//
// Storage shape, on the team record (`teams` store, `team/<id>.json`):
//   team.story = { answers: { [key]: string | string[] }, updatedAt, updatedBy, updatedByName }
//
// The link in the captain's email carries a stateless HMAC token bound to the
// team id + the captain's email, so a captain can answer without logging in but
// nobody can write another team's story. Same secret as the availability links.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Every question is optional. `type` drives the form control on the page and the
 * validation here:
 *   text   – multi-line free text (textarea), capped at `max` chars
 *   short  – one-line free text (input), capped at `max` chars
 *   chips  – pick from `options`; `multi` allows several. Stored as an array.
 *   select – one of `options`, stored as a string
 *   team   – one of the other teams in the season (free text, capped), the page
 *            offers the division's team names as suggestions
 * `public: false` keeps an answer off the team page (none today — everything a
 * captain writes here is meant to be read).
 */
export const QUESTIONS = [
  { key: 'intro',   type: 'text',   max: 400, label: 'Introduce the team in a sentence or two', hint: 'This one goes right at the top of your team page.' },
  { key: 'name',    type: 'text',   max: 400, label: 'How did you land on the team name?' },
  { key: 'how_met', type: 'chips',  multi: true, label: 'How does the team know each other?', hint: 'Pick everything that fits.',
    options: ['Friends', 'Family', 'Coworkers', 'Neighbors', 'Met at open play', 'Met through Dink Society', 'Mixed bag'] },
  { key: 'origin',  type: 'text',   max: 600, label: 'How did you all get into pickleball?', hint: 'Who started it, who got dragged along, who\'s hooked now.' },
  { key: 'since',   type: 'select', label: 'How long has the core of the team been playing?',
    options: ['Under a year', '1–2 years', '2–4 years', '4+ years', 'Since before it was cool'] },
  { key: 'courts',  type: 'text',   max: 300, label: 'Where do you usually play?', hint: 'Courts, clubs, parks — where people can actually find you.' },
  { key: 'when',    type: 'chips',  multi: true, label: 'When are you usually on a court?',
    options: ['Weekday mornings', 'Weekday evenings', 'Saturday', 'Sunday', 'Whenever there\'s a court'] },
  { key: 'style',   type: 'short',  max: 80,  label: 'Your style of play, in three words' },
  { key: 'ritual',  type: 'text',   max: 300, label: 'Pregame ritual, team chant, or superstition?' },
  { key: 'rival',   type: 'team',   max: 80,  label: 'Which team do you most want to beat this season?' },
  { key: 'after',   type: 'short',  max: 200, label: 'Where does the team end up after game night?' },
  { key: 'anthem',  type: 'short',  max: 120, label: 'The team\'s pump-up song' },
  { key: 'goal',    type: 'text',   max: 300, label: 'What does a great season look like for you?' },
  { key: 'fun',     type: 'text',   max: 300, label: 'One thing the league wouldn\'t guess about your team' },
  { key: 'shoutout', type: 'text',  max: 400, label: 'Anything you want to say to the rest of the Society?' },
];

const BY_KEY = new Map(QUESTIONS.map(q => [q.key, q]));

/** Collapse whitespace, strip control characters, cap length. */
function cleanText(v, max) {
  const s = String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/**
 * Validate a submitted answers object against QUESTIONS. Unknown keys are
 * dropped, empty answers are dropped, chip/select answers must come from the
 * question's options. Returns a clean `{ [key]: string | string[] }`.
 */
export function sanitizeAnswers(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, raw] of Object.entries(input)) {
    const q = BY_KEY.get(key);
    if (!q) continue;
    if (q.type === 'chips') {
      const vals = (Array.isArray(raw) ? raw : [raw]).map(v => String(v == null ? '' : v).trim()).filter(Boolean);
      const picked = [];
      for (const v of vals) if (q.options.includes(v) && !picked.includes(v)) picked.push(v);
      const kept = q.multi ? picked : picked.slice(0, 1);
      if (kept.length) out[key] = kept;
      continue;
    }
    if (q.type === 'select') {
      const v = String(raw == null ? '' : raw).trim();
      if (q.options.includes(v)) out[key] = v;
      continue;
    }
    const v = cleanText(raw, q.max || 400);
    if (v) out[key] = v;
  }
  return out;
}

/** How many questions have an answer. */
export function answeredCount(story) {
  const a = story && story.answers;
  return a && typeof a === 'object' ? Object.keys(a).filter(k => BY_KEY.has(k)).length : 0;
}

/**
 * What the public team page gets: the answered questions in questionnaire order,
 * each with its label, so the page never has to know the question list.
 * Returns null when nothing has been answered.
 */
export function publicStory(team) {
  const story = team && team.story;
  if (!story || !story.answers || typeof story.answers !== 'object') return null;
  const items = [];
  for (const q of QUESTIONS) {
    if (q.public === false) continue;
    const v = story.answers[q.key];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    items.push({ key: q.key, label: q.label, value: v });
  }
  if (!items.length) return null;
  return { items, updatedAt: story.updatedAt || null };
}

// ===== Signed link token =====

function secret() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('AVAILABILITY_TOKEN_SECRET'))
    || process.env.AVAILABILITY_TOKEN_SECRET
    || (typeof Netlify !== 'undefined' && Netlify.env.get('DROP_INGEST_TOKEN'))
    || process.env.DROP_INGEST_TOKEN
    || 'ds-team-story-insecure-fallback';
}
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sign = payload => b64url(createHmac('sha256', secret()).update('team-story:' + payload).digest());

/** Token for one team + the email it was sent to. No expiry — a team's story can be updated all season. */
export function signStoryToken({ teamId, email }) {
  const payload = b64url(JSON.stringify({ t: String(teamId), e: String(email || '').toLowerCase() }));
  return `${payload}.${sign(payload)}`;
}

/** Verify + decode. Returns { teamId, email } or null. */
export function verifyStoryToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  let ok = false;
  try {
    const a = Buffer.from(sig), b = Buffer.from(sign(payload));
    ok = a.length === b.length && timingSafeEqual(a, b);
  } catch { ok = false; }
  if (!ok) return null;
  try {
    const o = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!o || !o.t) return null;
    return { teamId: String(o.t), email: String(o.e || '') };
  } catch { return null; }
}

/** The link a captain gets. */
export function storyUrl(siteUrl, token) {
  return `${String(siteUrl || 'https://dinksociety.app').replace(/\/$/, '')}/team-story?t=${encodeURIComponent(token)}`;
}
