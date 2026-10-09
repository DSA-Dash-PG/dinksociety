// netlify/functions/lib/desk-inbox.js
//
// The Desk inbox — how write-ups produced OUTSIDE the site (the scheduled
// Claude tasks: the Friday Drop recap, the weekly Drop preview, the ladder
// recap editorial) reach the site without anyone copy/pasting them into the
// admin composer.
//
//   task  ── POST /desk-inbox ──▶  a DRAFT on the site + a review email to admins
//   admin ── one tap in email ──▶  /desk-approve puts it live and notifies players
//
// Nothing reaches a player until an admin approves. The inbox key the tasks
// hold can only file a draft and trigger the review email — the approve link
// is minted here and goes ONLY to the admin inbox, never back to the caller.
//
// Two kinds of item:
//   drop          a Drop edition (week-N, week-N-preview, championship-preview…)
//                 → saved through lib/drop.js saveDraft, exactly what the
//                   composer's "Save draft" does
//   ladder-recap  the "Part 2" write-up for one ladder night (title / dek /
//                 article / season note) → held here until approved, then
//                 merged into the night's recap draft and emailed to the roster
//
// Guards (all refusals are reported back to the caller, never silent):
//   - a PUBLISHED edition is never touched
//   - a draft an admin has edited in the composer is never overwritten
//   - a second submission for something still waiting on approval is refused
//     unless it is byte-for-byte the same (then it is a no-op) or says replace
//   - photos already attached to a draft are carried over
//
// Storage: blob store `desk-inbox`
//   item/drop/<circuit>/<edition>.json
//   item/ladder/<eventId>.json
// Tokens live in the existing `approval-tokens` store (kind:'desk') so there is
// one place to look, but only desk-approve honours them.

import { getStore } from '@netlify/blobs';
import { circuitCode, seasonName } from './circuit.js';
import { getDrop, saveDraft, parseEdition } from './drop.js';
import { sendEmail, htmlToPlain, messageLooksHtml } from './email.js';
import { adminEmailList } from './admin-auth.js';
import { siteUrl } from './ladder-notify.js';
import { getRecap } from './ladder-recap.js';
import { generateLadderRecapDraft } from './ladder-recap-generate.js';

export const DESK_WHO = 'desk-inbox';          // updatedBy stamp on drafts filed here
// Drafts last written by a machine may be replaced; one a person saved in the
// composer (updatedBy = their email) may not.
const MACHINE_AUTHORS = new Set([DESK_WHO, 'drop-generator', 'scheduled-task']);
const TOKEN_TTL_MS = 14 * 24 * 3600 * 1000;

function inbox() { return getStore({ name: 'desk-inbox', consistency: 'strong' }); }
function tokens() { return getStore({ name: 'approval-tokens', consistency: 'strong' }); }

function env(name) {
  return (typeof Netlify !== 'undefined' && Netlify.env.get(name)) || process.env[name] || '';
}

// ── the inbox key ───────────────────────────────────────────────────────────
// Its own secret on purpose: DROP_INGEST_TOKEN doubles as the HMAC secret for
// the availability and POTW shirt-size links, so it must never be handed to a
// scheduled task.
export function inboxKey() { return String(env('DESK_INBOX_KEY') || '').trim(); }

export function keyMatches(given) {
  const want = inboxKey();
  const got = String(given || '').trim();
  if (want.length < 24 || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// ── small helpers ───────────────────────────────────────────────────────────
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function words(html) {
  return htmlToPlain(html || '').split(/\s+/).filter(Boolean).length;
}

// ── markdown → HTML ─────────────────────────────────────────────────────────
// A server port of the composer's paste handler (admin.html mdToHtml) so a
// filed draft is stored exactly as if it had been pasted: blank line =
// paragraph, **bold**, *italic*, "- " lists. One addition: a block starting
// with "> " becomes the pull-quote (<blockquote>), which the article page has
// always styled but the paste path never produced.
function mdInline(t) {
  return t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\*([^*\s][^*]*)\*/g, '<i>$1</i>');
}
function mdEsc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function mdToHtml(md) {
  return String(md || '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map(b => {
    b = b.replace(/\s+$/, '');
    if (!b.trim()) return '';
    if (/^\s*>/.test(b)) {
      const q = b.split('\n').map(l => l.replace(/^\s*>\s?/, '')).join(' ').trim();
      return q ? '<blockquote>' + mdInline(mdEsc(q)) + '</blockquote>' : '';
    }
    const hm = b.match(/^(#{1,3})\s+([\s\S]*)$/);
    if (hm) { const lvl = Math.min(4, hm[1].length + 1); return `<h${lvl}>${mdInline(mdEsc(hm[2].trim()))}</h${lvl}>`; }
    const lines = b.split('\n');
    if (lines.every(l => /^\s*[-*]\s+/.test(l))) return '<ul>' + lines.map(l => '<li>' + mdInline(mdEsc(l.replace(/^\s*[-*]\s+/, ''))) + '</li>').join('') + '</ul>';
    if (lines.every(l => /^\s*\d+\.\s+/.test(l))) return '<ol>' + lines.map(l => '<li>' + mdInline(mdEsc(l.replace(/^\s*\d+\.\s+/, ''))) + '</li>').join('') + '</ol>';
    return '<p>' + mdInline(mdEsc(b)).replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

/** Rich text from a task: already-HTML is kept (it is sanitized on save), anything else is markdown. */
export function toHtml(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  return (messageLooksHtml(s) || /<blockquote\b/i.test(s)) ? s : mdToHtml(s);
}

/** "Team :: blurb" per line (the composer's Around the League box). */
export function parseTeamReports(text) {
  return String(text == null ? '' : text).split(/\n+/).map(line => {
    line = line.trim();
    if (!line) return null;
    let i = line.indexOf('::');
    if (i < 0) { i = line.indexOf(' - '); return i >= 0 ? { team: line.slice(0, i).trim(), blurb: line.slice(i + 3).trim() } : null; }
    return { team: line.slice(0, i).trim(), blurb: line.slice(i + 2).trim() };
  }).filter(x => x && x.team && x.blurb);
}

/** "Label: value, Label: value" (the composer's Chips box). */
export function parseChips(str) {
  if (Array.isArray(str)) return str.slice(0, 4);
  return String(str || '').split(',').map(part => {
    const t = part.trim();
    if (!t) return null;
    const idx = t.indexOf(':');
    if (idx < 0) return { label: t, value: '' };
    return { label: t.slice(0, idx).trim(), value: t.slice(idx + 1).trim() };
  }).filter(c => c && c.label).slice(0, 4);
}

const STORY_KINDS = ['title', 'upset', 'streak', 'riser', 'note'];
const isPlaceholder = (s) => /^<[^<>]*>$/.test(String(s || '').trim());

// ── the composer template → fields ──────────────────────────────────────────
// The Drop tasks write one Markdown file in a strict template: every composer
// field is its own fenced block under a heading that names the field. Parsing
// that file here means a task files exactly what it would have handed Richard
// to paste — one source, no second copy to drift.
export function parseDropTemplate(md) {
  const src = String(md || '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = { kicker: '', byline: '', title: '', dek: '', lead: '', around: '', storylines: [], notes: '', h1: '' };

  let label = '';          // the field name the next fenced block belongs to
  let inStories = false;
  let story = null;
  let publishAt = -1;      // line index of the "5 · Publish" heading

  const assign = (text) => {
    const l = label.toLowerCase();
    const v = text.replace(/\s+$/, '');
    if (story && inStories) {
      if (/\btag\b/.test(l)) story.tag = v.trim();
      else if (/headline/.test(l)) story.title = v.trim();
      else if (/\bbody\b/.test(l)) story.body = v;
      else if (/chips/.test(l)) story.chips = v.trim();
      return;
    }
    // "Dek (sub-headline)" also contains "headline" — test for the dek first.
    if (/kicker/.test(l)) out.kicker = v.trim();
    else if (/byline/.test(l)) out.byline = v.trim();
    else if (/\bdek\b/.test(l)) out.dek = v.trim();
    else if (/headline/.test(l)) out.title = v.trim();
    else if (/lead story/.test(l)) out.lead = v;
    else if (/around the league/.test(l)) out.around = v;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line)) {                      // a fenced block: runs to the next fence
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (label) assign(buf.join('\n'));
      label = '';
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const text = h[2].trim();
      if (h[1].length === 1 && !out.h1) out.h1 = text;
      if (/^storyline\s+\d+/i.test(text)) {
        inStories = true;
        story = { type: 'note', team: '', tag: '', title: '', body: '', chips: '' };
        out.storylines.push(story);
        label = '';
        continue;
      }
      const numbered = text.replace(/^\d+\s*[·.:\-–]\s*/, '');
      if (h[1].length === 2) {
        inStories = /^storylines?\b/i.test(numbered);
        if (!inStories) story = null;
        if (/^publish\b/i.test(numbered)) publishAt = i;
      }
      label = numbered;
      continue;
    }

    const b = line.match(/^\*\*(.+?)\*\*\s*(.*)$/);
    if (b) {
      const name = b[1].replace(/:\s*$/, '').trim();
      const code = (b[2].match(/`([^`]*)`/) || [])[1];
      if (story && inStories && /^type\b/i.test(name)) {
        const k = String(code || '').trim().toLowerCase();
        story.type = STORY_KINDS.includes(k) ? k : 'note';
        continue;
      }
      if (story && inStories && /^team\b/i.test(name)) {
        const t = String(code || '').trim();
        story.team = (isPlaceholder(t) || /^\(?\s*(leave\s+)?blank\s*\)?$/i.test(t)) ? '' : t;
        continue;
      }
      label = name;
    }
  }

  // Anything after a rule that follows the Publish section is for the editor's
  // eyes only ("Notes for Richard") — it rides along in the review email.
  if (publishAt >= 0) {
    for (let i = publishAt + 1; i < lines.length; i++) {
      if (/^-{3,}\s*$/.test(lines[i])) { out.notes = lines.slice(i + 1).join('\n').trim(); break; }
    }
  }
  if (!out.notes) {
    const m = src.match(/^\*\*Notes for [^\n]*\*\*[ \t]*\n([\s\S]*)$/m);
    if (m) out.notes = m[0].trim();
  }
  out.storylines = out.storylines.filter(s => s.title || s.body);
  return out;
}

/** The edition the template's own title line names, or null. A cross-check on the caller's `edition`. */
export function editionFromTitle(h1) {
  const s = String(h1 || '');
  let m = s.match(/week\s+(\d{1,2})\s+preview/i);
  if (m) return `week-${parseInt(m[1], 10)}-preview`;
  if (/championship\s+preview/i.test(s)) return 'championship-preview';
  if (/pre-?season/i.test(s)) return 'preseason';
  m = s.match(/week\s+(\d{1,2})\b/i);
  if (m) return `week-${parseInt(m[1], 10)}`;
  return null;
}

// ── tokens ──────────────────────────────────────────────────────────────────
// approve  single-use; desk-approve peeks it to draw the page and consumes it
//          on the POST that actually publishes
// view     reusable until it expires; lets the article page render the draft
//          for someone who is not signed in to admin
async function mintToken(action, item) {
  const token = randomHex(24);
  await tokens().setJSON(`token/${token}.json`, {
    token, kind: 'desk', action, item,
    teamId: null, playerId: 'desk',            // shape parity with the other approval tokens
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
    used: false,
  });
  return token;
}

const validToken = (t) => !!t && /^[a-f0-9]{48}$/.test(t);

/** The token record whatever its state (used / expired included), or null. Never trusted on its own — callers check `usable`. */
export async function readDeskToken(token) {
  if (!validToken(token)) return null;
  const rec = await tokens().get(`token/${token}.json`, { type: 'json' }).catch(() => null);
  if (!rec || rec.kind !== 'desk' || !rec.item) return null;
  const expired = new Date(rec.expiresAt).getTime() < Date.now();
  return { ...rec, expired, usable: !rec.used && !expired };
}

/** Mark an approve token used BEFORE acting, so a double tap cannot publish twice. Returns the record or null. */
export async function consumeDeskToken(token) {
  const rec = await readDeskToken(token);
  if (!rec || !rec.usable || rec.action !== 'approve') return null;
  try {
    const { expired, usable, ...stored } = rec;
    await tokens().setJSON(`token/${token}.json`, { ...stored, used: true, usedAt: new Date().toISOString() });
  } catch { return null; }
  return rec;
}

/** Hand an approve token back after a failure that changed nothing, so the same email link can be tried again. */
export async function releaseDeskToken(token) {
  const rec = await readDeskToken(token);
  if (!rec || rec.expired || !rec.used) return false;
  const { expired, usable, usedAt, ...stored } = rec;
  await tokens().setJSON(`token/${token}.json`, { ...stored, used: false }).catch(() => {});
  return true;
}

// ── inbox items ─────────────────────────────────────────────────────────────
function itemKey(ref) {
  return ref.kind === 'drop'
    ? `item/drop/${circuitCode(ref.circuit)}/${ref.edition}.json`
    : `item/ladder/${ref.eventId}.json`;
}
export async function getItem(ref) { return inbox().get(itemKey(ref), { type: 'json' }).catch(() => null); }
export async function saveItem(item) { await inbox().setJSON(itemKey(item), item); return item; }

/** What is sitting in the inbox, newest first — the tasks ask this before writing so a re-run never redoes an edition. */
export async function listItems({ kind = null, circuit = null } = {}) {
  const s = inbox();
  const prefix = kind === 'drop' ? (circuit ? `item/drop/${circuitCode(circuit)}/` : 'item/drop/')
    : kind === 'ladder-recap' ? 'item/ladder/' : 'item/';
  const { blobs } = await s.list({ prefix }).catch(() => ({ blobs: [] }));
  const recs = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
  recs.sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')));
  return recs.map(r => ({
    kind: r.kind, circuit: r.circuit || null, edition: r.edition || null, eventId: r.eventId || null,
    status: r.status, title: r.title || null, receivedAt: r.receivedAt || null, approvedAt: r.approvedAt || null,
  }));
}

// `http` is the response code for the endpoint; it is stripped before replying.
function refuse(http, reason, message, extra = {}) {
  return { ok: false, http, reason, message, ...extra };
}

function reviewRecipients() {
  const list = adminEmailList();
  if (list.length) return list;
  return String(env('ADMIN_NOTIFY_EMAIL') || '').split(',').map(s => s.trim().toLowerCase()).filter(e => e.includes('@'));
}

function approveUrl(token) { return `${siteUrl()}/.netlify/functions/desk-approve?t=${token}`; }

// ── kind: drop ──────────────────────────────────────────────────────────────
/**
 * Turn whatever a task sent into the composer's save shape.
 * Accepts the Markdown template (`markdown`), or JSON using either the
 * template's field names (lead / aroundTheLeague / storylines[].headline,
 * body, type) or the composer's own (leadHtml / teamReports / storylines[].
 * title, html, tagKind).
 */
export function dropInputFrom(body = {}) {
  let src = body;
  let notes = String(body.notes || '').trim();
  let h1 = '';
  if (typeof body.markdown === 'string' && body.markdown.trim()) {
    const t = parseDropTemplate(body.markdown);
    h1 = t.h1;
    notes = notes || t.notes;
    src = { ...body, kicker: t.kicker, byline: t.byline, title: t.title, dek: t.dek, lead: t.lead, aroundTheLeague: t.around, storylines: t.storylines };
  }
  const storylines = (Array.isArray(src.storylines) ? src.storylines : []).map(s => {
    const kind = String(s.tagKind || s.type || 'note').trim().toLowerCase();
    return {
      tag: String(s.tag || '').trim(),
      tagKind: STORY_KINDS.includes(kind) ? kind : 'note',
      team: String(s.team || '').trim(),
      title: String(s.title || s.headline || '').trim(),
      html: toHtml(s.html || s.body || ''),
      chips: parseChips(s.chips),
    };
  });
  const teamReports = Array.isArray(src.teamReports) ? src.teamReports : parseTeamReports(src.aroundTheLeague || src.around || '');
  return {
    h1, notes,
    input: {
      kicker: String(src.kicker || '').trim(),
      byline: String(src.byline || '').trim(),
      title: String(src.title || src.headline || '').trim(),
      dek: String(src.dek || '').trim(),
      leadHtml: toHtml(src.leadHtml || src.lead || ''),
      teamReports,
      storylines,
      label: src.label || undefined,
      after: (src.after === '' || src.after == null) ? undefined : Number(src.after),
    },
  };
}

function dropProblems(input) {
  const bad = [];
  if (!input.title || isPlaceholder(input.title)) bad.push('lead headline');
  if (words(input.leadHtml) < 40) bad.push('lead story');
  if (!input.storylines.length) bad.push('storylines');
  input.storylines.forEach((s, i) => {
    if (!s.title || isPlaceholder(s.title)) bad.push(`storyline ${i + 1} headline`);
    if (words(s.html) < 15) bad.push(`storyline ${i + 1} body`);
  });
  if (!input.teamReports.length) bad.push('Around the League');
  return bad;
}

/**
 * File a Drop edition as a draft and email the admins a one-tap approve link.
 * @returns {Promise<object>} { ok:true, … } or { ok:false, http, reason, message }
 */
export async function fileDrop(body = {}) {
  if (!body.circuit) return refuse(400, 'circuit-required', 'Say which season this is for (circuit, e.g. "II").');
  const code = circuitCode(body.circuit);
  const ed = parseEdition(body.edition ?? body.week);
  if (!ed) return refuse(400, 'edition-required', 'Say which edition this is (e.g. "week-5", "week-5-preview", "championship-preview").');

  const { input, notes, h1 } = dropInputFrom(body);

  // The file names its own edition in its title line. If that disagrees with
  // what the caller asked for, one of them is wrong — refuse rather than file
  // Week 4's recap under Week 5.
  const named = editionFromTitle(h1);
  if (named && named !== ed.id) {
    return refuse(422, 'edition-mismatch', `The write-up's title says "${h1}" (${named}) but it was filed as ${ed.id}.`);
  }

  const bad = dropProblems(input);
  if (bad.length) return refuse(422, 'incomplete', `Missing or too short: ${bad.join(', ')}.`, { missing: bad });

  const existing = await getDrop(code, ed.id);
  const item = await getItem({ kind: 'drop', circuit: code, edition: ed.id });
  const hash = await sha256(JSON.stringify(input));
  const replace = body.replace === true;

  if (existing && existing.status === 'published') {
    return refuse(409, 'already-published', `${existing.label || ed.id} is already published.`);
  }
  if (existing && item && item.status === 'pending' && item.hash === hash) {
    return { ok: true, unchanged: true, kind: 'drop', circuit: code, edition: ed.id, status: existing.status, title: existing.title, receivedAt: item.receivedAt, emailed: false };
  }
  if (existing && existing.updatedBy && !MACHINE_AUTHORS.has(existing.updatedBy) && !replace) {
    return refuse(409, 'edited-in-admin', `${existing.label || ed.id} already has a draft that ${existing.updatedBy} edited in admin. It was left alone.`);
  }
  if (existing && item && item.status === 'pending' && !replace) {
    return refuse(409, 'already-pending', `${existing.label || ed.id} is already drafted and waiting for approval (filed ${item.receivedAt}).`, { receivedAt: item.receivedAt });
  }

  // Keep any photos already on the draft: the cover, the gallery, and each
  // storyline's photos (matched by team, else by position).
  if (existing) {
    input.cover = existing.cover || null;
    input.gallery = existing.gallery || [];
    const old = existing.storylines || [];
    input.storylines.forEach((s, i) => {
      const match = (s.team && old.find(o => o.team && o.team === s.team)) || old[i];
      if (match && Array.isArray(match.images) && match.images.length) s.images = match.images;
    });
  }

  const rec = await saveDraft(code, ed.id, { ...input, generatedBy: 'auto', source: String(body.source || 'scheduled-task').slice(0, 60) }, DESK_WHO);

  const ref = { kind: 'drop', circuit: code, edition: rec.edition };
  const view = await mintToken('view', ref);
  const approve = await mintToken('approve', { ...ref, view });
  const now = new Date().toISOString();
  const saved = await saveItem({
    ...ref, status: 'pending', hash, title: rec.title, notes: notes.slice(0, 6000),
    receivedAt: now, source: rec.source || null, approveToken: approve, viewToken: view,
    emailedAt: null, emailedTo: [], approvedAt: null,
  });

  const mail = await emailDropReview(rec, saved).catch(e => ({ ok: false, error: String(e && e.message || e) }));
  if (mail.ok) await saveItem({ ...saved, emailedAt: new Date().toISOString(), emailedTo: mail.to });
  else console.error('[desk-inbox] review email failed:', mail.error);

  return {
    ok: true, kind: 'drop', circuit: code, edition: rec.edition, label: rec.label, status: rec.status,
    title: rec.title, readMins: rec.readMins, storylines: rec.storylines.length, teamReports: rec.teamReports.length,
    replaced: !!existing, emailed: !!mail.ok, emailedTo: mail.ok ? mail.to.length : 0, emailError: mail.ok ? null : mail.error,
  };
}

// ── kind: ladder-recap ──────────────────────────────────────────────────────
// The ladder email renders only p / b / strong / em / blockquote (see
// lib/ladder-recap-email.js safeHtml), so normalise to exactly that set.
export function ladderHtml(v) {
  return toHtml(v)
    .replace(/<(\/?)i>/gi, '<$1em>')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\/?)(p|b|strong|em|blockquote)\b[^>]*>/gi, '<$1$2>')
    .replace(/<(?!\/?(p|b|strong|em|blockquote)>)[^>]*>/gi, '');
}

export async function fileLadderRecap(body = {}) {
  const eventId = String(body.eventId || body.event || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(eventId)) return refuse(400, 'event-required', 'Say which ladder night this is for (eventId).');

  const payload = {
    title: String(body.title || '').trim().slice(0, 200),
    dek: String(body.dek || '').trim().slice(0, 300),
    html: ladderHtml(body.html || body.article || ''),
    seasonNote: htmlToPlain(ladderHtml(body.seasonNote || body.season_note || '')).replace(/\s+/g, ' ').trim().slice(0, 600),
  };
  const bad = [];
  if (!payload.title || isPlaceholder(payload.title)) bad.push('title');
  if (words(payload.html) < 30) bad.push('article');
  if (bad.length) return refuse(422, 'incomplete', `Missing or too short: ${bad.join(', ')}.`, { missing: bad });

  // The write-up hangs off the night's recap draft (per-player numbers, podium,
  // send list). If the night has none yet, build it the way the cron would.
  let recap = await getRecap(eventId);
  if (!recap) {
    const made = await generateLadderRecapDraft(eventId, {}).catch(e => ({ ok: false, reason: String(e && e.message || e) }));
    if (!made.ok) return refuse(409, 'no-recap-draft', `No recap exists for ladder ${eventId} yet (${made.reason || 'not scored'}). The night has to be marked final first.`);
    recap = made.record;
  }

  const ref = { kind: 'ladder-recap', eventId };
  const item = await getItem(ref);
  const hash = await sha256(JSON.stringify(payload));
  const replace = body.replace === true;
  if (item && item.status === 'pending' && item.hash === hash) {
    return { ok: true, unchanged: true, kind: 'ladder-recap', eventId, title: item.title, receivedAt: item.receivedAt, emailed: false };
  }
  if (item && item.status === 'pending' && !replace) {
    return refuse(409, 'already-pending', `A write-up for ${recap.event?.name || eventId} is already waiting for approval (filed ${item.receivedAt}).`, { receivedAt: item.receivedAt });
  }
  if (item && item.status === 'approved' && !replace) {
    return refuse(409, 'already-approved', `A write-up for ${recap.event?.name || eventId} was already approved and sent (${item.approvedAt}).`);
  }

  const approve = await mintToken('approve', ref);
  const now = new Date().toISOString();
  const saved = await saveItem({
    ...ref, status: 'pending', hash, title: payload.title, payload,
    notes: String(body.notes || '').trim().slice(0, 6000),
    eventName: recap.event?.name || null, eventDate: recap.event?.date || null,
    receivedAt: now, source: String(body.source || 'scheduled-task').slice(0, 60),
    approveToken: approve, emailedAt: null, emailedTo: [], approvedAt: null,
  });

  const mail = await emailLadderReview(recap, saved).catch(e => ({ ok: false, error: String(e && e.message || e) }));
  if (mail.ok) await saveItem({ ...saved, emailedAt: new Date().toISOString(), emailedTo: mail.to });
  else console.error('[desk-inbox] ladder review email failed:', mail.error);

  return {
    ok: true, kind: 'ladder-recap', eventId, eventName: recap.event?.name || null, title: payload.title,
    recipients: (recap.recipients || []).length, recapAlreadySent: recap.status === 'sent',
    replaced: !!item, emailed: !!mail.ok, emailedTo: mail.ok ? mail.to.length : 0, emailError: mail.ok ? null : mail.error,
  };
}

// ── review emails ───────────────────────────────────────────────────────────
const C = { bg: '#0e0e0e', card: '#161616', line: '#2a2a2a', text: '#f5f5f5', body: '#d6d9d0', mute: '#8a8a8a', lime: '#b8ff2c', teal: '#17d7b0', gold: '#f5c842' };

/** Stored article HTML has bare tags (attributes are stripped on save) — dress them for a dark email. */
export function emailify(html) {
  return String(html || '')
    .replace(/<p>/gi, `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:${C.body};">`)
    .replace(/<(b|strong)>/gi, `<$1 style="color:${C.text};">`)
    .replace(/<blockquote>/gi, `<blockquote style="margin:18px 0;padding:4px 0 4px 16px;border-left:3px solid ${C.lime};font-size:17px;line-height:1.45;font-style:italic;color:${C.text};">`)
    .replace(/<(ul|ol)>/gi, `<$1 style="margin:0 0 14px;padding-left:20px;color:${C.body};font-size:15px;line-height:1.6;">`)
    .replace(/<h([234])>/gi, `<h$1 style="margin:18px 0 8px;font-size:16px;color:${C.text};">`)
    .replace(/<a /gi, `<a style="color:${C.lime};" `);
}

function button(href, label, primary = true) {
  return primary
    ? `<a href="${href}" style="display:block;text-align:center;padding:16px 12px;background:${C.lime};color:#0e0e0e;font-size:16px;font-weight:800;text-decoration:none;border-radius:9999px;">${label}</a>`
    : `<a href="${href}" style="display:block;text-align:center;padding:12px 10px;background:transparent;color:${C.text};font-size:14px;font-weight:700;text-decoration:none;border:1px solid #3a3a3a;border-radius:9999px;">${label}</a>`;
}

function notesBlock(raw) {
  // Drop the run's own "Notes for Richard (not for pasting)" title line (the
  // box has a heading) and the code ticks around ids, which read as noise here.
  const notes = String(raw || '').replace(/^\s*\*\*Notes for [^\n]*\*\*[ \t]*\n?/i, '').replace(/`/g, '').trim();
  if (!notes) return '';
  return `<div style="margin:0 0 22px;padding:14px 16px;background:rgba(245,200,66,0.08);border:1px solid rgba(245,200,66,0.3);border-radius:10px;">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.gold};margin-bottom:8px;">Notes for you &middot; not published</div>
      ${emailify(mdToHtml(notes)).replace(/font-size:15px/g, 'font-size:13px')}
    </div>`;
}

function shell(inner) {
  return `<div style="font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:600px;margin:0 auto;padding:32px 20px;background:${C.bg};color:${C.text};">
    <div style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:${C.text};margin-bottom:22px;">THE DINK SOCIETY</div>
    ${inner}
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid ${C.line};font-size:11px;color:#555;">The Dink Society &middot; sent to league admins &middot; the approve link works once and expires in 14 days</div>
  </div>`;
}

export function renderDropReview({ rec, item, site }) {
  const approve = `${site}/.netlify/functions/desk-approve?t=${item.approveToken}`;
  const preview = `${site}/drop.html?edition=${encodeURIComponent(rec.edition)}&circuit=${encodeURIComponent(rec.circuit)}&preview=1&t=${item.viewToken}`;
  const admin = `${site}/admin.html`;
  const kicker = rec.kicker || `The Drop · ${rec.label}`;
  const teams = (rec.teamReports || []).map(r =>
    `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;color:${C.body};"><b style="color:${C.text};">${esc(r.team)}</b> &mdash; ${esc(r.blurb)}</p>`).join('');
  const stories = (rec.storylines || []).map((s, i) => {
    const chips = (s.chips || []).map(c => `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border:1px solid #333;border-radius:9999px;font-size:11px;color:${C.mute};">${esc(c.label)}${c.value ? `: <b style="color:${C.text};">${esc(c.value)}</b>` : ''}</span>`).join('');
    return `<div style="margin:0 0 22px;padding:16px;background:${C.card};border-radius:10px;">
        <div style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.teal};margin-bottom:6px;">${i + 1} &middot; ${esc(s.tag || s.tagKind)}${s.team ? ` &middot; ${esc(s.team)}` : ''}</div>
        <div style="font-size:18px;font-weight:800;line-height:1.3;color:${C.text};margin-bottom:10px;">${esc(s.title)}</div>
        ${emailify(s.html)}
        ${chips ? `<div style="margin-top:4px;">${chips}</div>` : ''}
      </div>`;
  }).join('');

  return shell(`
    <div style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.lime};margin-bottom:8px;">${esc(kicker)} &middot; ${esc(seasonName(rec.circuit))} &middot; ready for your review</div>
    <h1 style="font-size:24px;font-weight:800;line-height:1.25;color:${C.text};margin:0 0 10px;">${esc(rec.title)}</h1>
    ${rec.dek ? `<p style="font-size:15px;line-height:1.55;color:${C.body};font-style:italic;margin:0 0 12px;">${esc(rec.dek)}</p>` : ''}
    <p style="font-size:12px;color:${C.mute};margin:0 0 20px;">${esc(rec.byline || '')} &middot; about ${rec.readMins} min read &middot; ${(rec.storylines || []).length} storylines &middot; ${(rec.teamReports || []).length} team blurbs</p>
    <div style="margin:0 0 10px;">${button(approve, '&#10003; Approve &amp; publish')}</div>
    <p style="font-size:12px;line-height:1.5;color:${C.mute};margin:0 0 14px;">One tap puts it live on the site, posts it to every team portal and emails the players. No sign-in.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px;"><tr>
      <td style="padding-right:6px;width:50%;">${button(preview, 'See it as the article', false)}</td>
      <td style="padding-left:6px;width:50%;">${button(admin, 'Edit in admin', false)}</td>
    </tr></table>
    ${notesBlock(item.notes)}
    <div style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.mute};margin:0 0 12px;">The lead</div>
    ${emailify(rec.leadHtml)}
    ${teams ? `<div style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.mute};margin:22px 0 12px;">Around the League</div>${teams}` : ''}
    ${stories ? `<div style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.mute};margin:22px 0 12px;">Storylines</div>${stories}` : ''}
    <div style="margin:6px 0 10px;">${button(approve, '&#10003; Approve &amp; publish')}</div>
    <p style="font-size:12px;line-height:1.5;color:${C.mute};margin:0;">Want photos or a tweak first? Open The Drop in admin (working season ${esc(seasonName(rec.circuit))}), edit and save the draft, then tap Approve here. It publishes whatever is saved at that moment.</p>
  `);
}

async function emailDropReview(rec, item) {
  const to = reviewRecipients();
  if (!to.length) return { ok: false, error: 'No admin email configured (ADMIN_EMAILS)' };
  const title = rec.title.length > 90 ? rec.title.slice(0, 87) + '…' : rec.title;
  await sendEmail({
    to,
    subject: `Approve: ${rec.kicker || 'The Drop · ' + rec.label} — ${title}`,
    html: renderDropReview({ rec, item, site: siteUrl() }),
  });
  return { ok: true, to };
}

export function renderLadderReview({ recap, item, site }) {
  const approve = `${site}/.netlify/functions/desk-approve?t=${item.approveToken}`;
  const admin = `${site}/admin-ladders.html`;
  const n = (recap.recipients || []).length;
  const p = item.payload;
  const already = recap.status === 'sent';
  const when = recap.sentAt ? new Date(recap.sentAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const sendLine = already
    ? `Heads up: the automatic recap for this night already went out${when ? ` (${esc(when)} PT)` : ''}. Approving saves this write-up and emails the recap to ${n} player${n === 1 ? '' : 's'} again with it.`
    : `One tap saves this as the night's write-up and emails the recap to ${n} player${n === 1 ? '' : 's'}. No sign-in.`;
  return shell(`
    <div style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.lime};margin-bottom:8px;">Ladder recap &middot; ${esc(recap.event?.name || 'Ladder night')}${recap.event?.date ? ` &middot; ${esc(recap.event.date)}` : ''} &middot; ready for your review</div>
    <h1 style="font-size:24px;font-weight:800;line-height:1.25;color:${C.text};margin:0 0 10px;">${esc(p.title)}</h1>
    ${p.dek ? `<p style="font-size:15px;line-height:1.55;color:${C.body};font-style:italic;margin:0 0 18px;">${esc(p.dek)}</p>` : ''}
    <div style="margin:0 0 10px;">${button(approve, `&#10003; Approve &amp; send to ${n} player${n === 1 ? '' : 's'}`)}</div>
    <p style="font-size:12px;line-height:1.5;color:${already ? C.gold : C.mute};margin:0 0 14px;">${sendLine}</p>
    <div style="margin:0 0 24px;">${button(admin, 'Edit in admin instead', false)}</div>
    ${notesBlock(item.notes)}
    <div style="font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${C.mute};margin:0 0 12px;">The write-up</div>
    ${emailify(p.html)}
    ${p.seasonNote ? `<div style="background:rgba(184,255,44,.1);border:1px solid rgba(184,255,44,.22);border-radius:10px;padding:13px 15px;margin:6px 0 0;font-size:14px;line-height:1.55;color:#eef3e4;">${esc(p.seasonNote)}</div>` : ''}
    <p style="font-size:12px;line-height:1.5;color:${C.mute};margin:18px 0 0;">Each player's own numbers and the podium are filled in from the night's scores, as usual. Only the headline, sub-headline, article and season note above come from this write-up.</p>
  `);
}

async function emailLadderReview(recap, item) {
  const to = reviewRecipients();
  if (!to.length) return { ok: false, error: 'No admin email configured (ADMIN_EMAILS)' };
  await sendEmail({
    to,
    subject: `Approve: ladder recap — ${recap.event?.name || 'Ladder night'}`,
    html: renderLadderReview({ recap, item, site: siteUrl() }),
  });
  return { ok: true, to };
}
