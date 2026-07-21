// netlify/functions/lib/drop.js
//
// Storage + helpers for "The Drop" — the weekly editorial column.
//
// One record per week per circuit, stored in the `drop` blob store:
//   drop/<circuit>/week-<n>.json
//
// A record carries the editorial (lead story + Claude-picked storylines) plus
// a snapshot of that week's performers (POTW M/F, Team of the Week, DSR risers)
// taken at publish time so the article never drifts as later weeks recompute.
//
// Lifecycle:
//   draft      → created by the weekly scheduled task (or hand-written in admin),
//                editable, NEVER shown publicly.
//   published  → approved in the admin composer; powers the homepage teaser and
//                the /drop.html article page; also fires the email + portal
//                broadcast.
//
// Reads/writes here use strong consistency so the admin edit→publish loop never
// races (same rule the scoring path follows). Public reads go through
// public-drop.js with ETag caching instead.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './circuit.js';
import { sanitizeMessageHtml, messageLooksHtml, htmlToPlain } from './email.js';

const STORE = 'drop';

function store() {
  return getStore({ name: STORE, consistency: 'strong' });
}

export function dropKey(circuit, week) {
  return `drop/${circuitCode(circuit)}/week-${Number(week)}.json`;
}

// Clean a rich-text fragment the same way broadcasts are sanitized; fall back to
// an empty string for anything that doesn't look like HTML.
function cleanHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  return messageLooksHtml(html) ? sanitizeMessageHtml(html) : sanitizeMessageHtml(`<p>${html}</p>`);
}

// Focal point for a photo, as percentages of the image box: { x, y } where
// 0/0 is top-left and 100/100 is bottom-right. The article crops photos to
// several fixed aspect ratios (hero, floated portrait, mosaic tiles), so the
// focal point is what keeps a subject's head in frame instead of centring
// blindly. null means "no preference" and the renderer falls back to 50/50.
function normFocal(f) {
  if (!f || typeof f !== 'object') return null;
  const x = Number(f.x), y = Number(f.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
  return { x: clamp(x), y: clamp(y) };
}

// Normalize a photo reference. Photos live in the 'drop-photos' blob store,
// keyed by an immutable id; the record only stores the id plus an optional
// caption/credit/focal point. Returns null for anything without a valid id, so
// every photo slot degrades cleanly to "no image" (the article renders text-only).
const VALID_IMG_ID = /^[a-zA-Z0-9_-]{1,80}$/;
function normImage(x) {
  if (!x || typeof x !== 'object') return null;
  const id = String(x.id || x.imageId || '').trim();
  if (!id || !VALID_IMG_ID.test(id)) return null;
  return {
    id,
    caption: x.caption ? String(x.caption).slice(0, 240) : null,
    credit: x.credit ? String(x.credit).slice(0, 120) : null,
    focal: normFocal(x.focal),
    // Gallery photos only: when true, the photo is also floated into the lead
    // story (it still appears in the Week in Pictures mosaic). Ignored for the
    // cover and storyline thumbnails, which have their own fixed slots.
    lead: x.lead === true,
  };
}

// A "Week in Pictures" gallery: an ordered list of photos (each id + caption).
function normGallery(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 24).map(normImage).filter(Boolean);
}

// Normalize a storyline into the shape the article page + composer expect.
function normStoryline(s = {}) {
  const tagKind = ['title', 'upset', 'streak', 'riser', 'note'].includes(s.tagKind) ? s.tagKind : 'note';
  const chips = Array.isArray(s.chips)
    ? s.chips.slice(0, 4).map(c => ({ label: String(c.label || '').slice(0, 40), value: String(c.value ?? '').slice(0, 40) }))
    : [];
  // A storyline can carry multiple photos (images[]), which the article floats
  // and wraps the copy around. Backward-compatible with the old single `image`.
  const rawImgs = Array.isArray(s.images) ? s.images : (s.image ? [s.image] : []);
  const images = rawImgs.slice(0, 4).map(normImage).filter(Boolean);
  return {
    tag: String(s.tag || '').slice(0, 40),
    tagKind,
    title: String(s.title || '').slice(0, 200),
    html: cleanHtml(s.html),
    chips,
    images,
    image: images[0] || null, // legacy field: first photo, for older readers
  };
}

// "Around the League" — a short summary for every team, so even swept teams get
// a bright spot. Each entry is { team, blurb }.
function normTeamReports(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 24).map(r => ({
    team: String(r?.team || '').slice(0, 80),
    blurb: String(r?.blurb || '').slice(0, 600),
  })).filter(r => r.team && r.blurb);
}

// Build the editorial portion of a record from arbitrary input (generator or
// admin edit). Does NOT set status/performers — see saveDraft/publishDrop.
function normEditorial(input = {}) {
  const storylines = Array.isArray(input.storylines)
    ? input.storylines.slice(0, 6).map(normStoryline).filter(s => s.title || s.html)
    : [];
  const leadHtml = cleanHtml(input.leadHtml);
  return {
    kicker: String(input.kicker || '').slice(0, 80) || null,
    title: String(input.title || '').slice(0, 240),
    dek: String(input.dek || '').slice(0, 400) || null,
    byline: String(input.byline || 'By The Society Desk').slice(0, 120),
    readMins: Number.isFinite(+input.readMins) ? Math.max(1, Math.min(20, Math.round(+input.readMins))) : estimateReadMins(leadHtml, storylines),
    leadHtml,
    cover: normImage(input.cover),      // optional hero photo under the headline
    teamReports: normTeamReports(input.teamReports),
    storylines,
    gallery: normGallery(input.gallery), // optional "Week in Pictures" grid
  };
}

function estimateReadMins(leadHtml, storylines) {
  const words = [leadHtml, ...storylines.map(s => s.html + ' ' + s.title)]
    .map(htmlToPlain).join(' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// Snapshot performers for storage:
//   potw M/F, Team of the Week, DSR risers (legacy), the tabbed Top Performers
//   leaderboard (top 6 × dsr/diff/pts × M/F), and Top Climbers (DSR rank jumps).
function normPerformers(p = {}) {
  const player = (x) => x ? {
    playerId: x.playerId || null,
    name: String(x.name || '').slice(0, 80),
    teamName: x.teamName ? String(x.teamName).slice(0, 80) : null,
    w: x.w ?? null, l: x.l ?? null, dsr: x.dsr ?? null, diff: x.diff ?? null, ps: x.ps ?? null,
    isChef: x.isChef !== false, // K'CHN chef badge
  } : null;
  // A ranked leaderboard row (Top Performers tabs). Slimmer than `player`.
  const row = (x) => x ? {
    playerId: x.playerId || null,
    name: String(x.name || '').slice(0, 80),
    teamName: x.teamName ? String(x.teamName).slice(0, 80) : null,
    w: x.w ?? null, l: x.l ?? null, dsr: x.dsr ?? null, diff: x.diff ?? null, ps: x.ps ?? null,
  } : null;
  const list = (a) => Array.isArray(a) ? a.slice(0, 6).map(row).filter(Boolean) : [];
  const metricSet = (m) => (m && (m.dsr || m.diff || m.pts)) ? {
    dsr: list(m.dsr), diff: list(m.diff), pts: list(m.pts),
  } : null;
  const tp = p?.topPerformers;
  const topPerformers = (tp && (tp.men || tp.women)) ? {
    men: metricSet(tp.men), women: metricSet(tp.women),
  } : null;
  return {
    potw: {
      men: player(p?.potw?.men),
      women: player(p?.potw?.women),
    },
    teamOfWeek: p?.teamOfWeek ? {
      name: String(p.teamOfWeek.name || '').slice(0, 80),
      emoji: p.teamOfWeek.emoji || null,
      record: p.teamOfWeek.record ? String(p.teamOfWeek.record).slice(0, 40) : null,
      note: p.teamOfWeek.note ? String(p.teamOfWeek.note).slice(0, 200) : null,
    } : null,
    topPerformers,
    climbers: Array.isArray(p?.climbers)
      ? p.climbers.slice(0, 6).map(c => ({
          name: String(c.name || '').slice(0, 80),
          teamName: c.teamName ? String(c.teamName).slice(0, 80) : null,
          delta: (c.delta != null && Number.isFinite(+c.delta)) ? +c.delta : null,
          rank: (c.rank != null && Number.isFinite(+c.rank)) ? +c.rank : null,
          fromRank: (c.fromRank != null && Number.isFinite(+c.fromRank)) ? +c.fromRank : null,
        }))
      : [],
    risers: Array.isArray(p?.risers)
      ? p.risers.slice(0, 6).map(r => ({
          name: String(r.name || '').slice(0, 80),
          delta: Number.isFinite(+r.delta) ? +r.delta : null,
          dir: r.dir === 'dn' ? 'dn' : 'up',
        }))
      : [],
  };
}

/** Get the raw record for one week (any status). null if none. */
export async function getDrop(circuit, week) {
  return store().get(dropKey(circuit, week), { type: 'json' }).catch(() => null);
}

/**
 * Upsert the editorial for a week as a DRAFT (or update an existing record's
 * editorial in place, preserving published status when already live).
 * `performers` is optional and stored as the working snapshot for the composer.
 */
export async function saveDraft(circuit, week, input, who = null) {
  const code = circuitCode(circuit);
  const existing = await getDrop(code, week);
  const now = new Date().toISOString();
  const rec = {
    circuit: code,
    week: Number(week),
    status: existing?.status === 'published' ? 'published' : 'draft',
    ...normEditorial(input),
    performers: input.performers ? normPerformers(input.performers) : (existing?.performers || normPerformers()),
    generatedBy: input.generatedBy || existing?.generatedBy || 'manual',
    source: input.source || existing?.source || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    publishedAt: existing?.publishedAt || null,
    sentBy: existing?.sentBy || null,
    updatedBy: who,
  };
  await store().setJSON(dropKey(code, week), rec);
  return rec;
}

/**
 * Mark a week's Drop published. Optionally re-snapshot performers at publish
 * time (pass the freshest live performers). Returns the published record.
 */
export async function publishDrop(circuit, week, who = null, performers = null) {
  const code = circuitCode(circuit);
  const existing = await getDrop(code, week);
  if (!existing) throw new Error(`No Drop draft for circuit ${code} week ${week}`);
  const now = new Date().toISOString();
  const rec = {
    ...existing,
    status: 'published',
    performers: performers ? normPerformers(performers) : existing.performers,
    publishedAt: existing.publishedAt || now,
    rePublishedAt: existing.publishedAt ? now : null,
    updatedAt: now,
    sentBy: who || existing.sentBy,
  };
  await store().setJSON(dropKey(code, week), rec);
  return rec;
}

/** Revert a published week back to draft (un-publish). */
export async function unpublishDrop(circuit, week) {
  const code = circuitCode(circuit);
  const existing = await getDrop(code, week);
  if (!existing) return null;
  const rec = { ...existing, status: 'draft', updatedAt: new Date().toISOString() };
  await store().setJSON(dropKey(code, week), rec);
  return rec;
}

/** List every week's record for a circuit, newest week first. */
export async function listDrops(circuit) {
  const code = circuitCode(circuit);
  const s = store();
  const { blobs } = await s.list({ prefix: `drop/${code}/` }).catch(() => ({ blobs: [] }));
  const recs = (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
  recs.sort((a, b) => (b.week || 0) - (a.week || 0));
  return recs;
}

/** The most recent PUBLISHED Drop for a circuit, or null. */
export async function getLatestPublished(circuit) {
  const recs = await listDrops(circuit);
  return recs.find(r => r.status === 'published') || null;
}

/** Trim a record to the public shape (drops nothing sensitive — editorial is public once published). */
export function toPublic(rec) {
  if (!rec) return null;
  return {
    circuit: rec.circuit,
    week: rec.week,
    kicker: rec.kicker,
    title: rec.title,
    dek: rec.dek,
    byline: rec.byline,
    readMins: rec.readMins,
    leadHtml: rec.leadHtml,
    cover: rec.cover || null,
    teamReports: rec.teamReports || [],
    storylines: rec.storylines || [],
    gallery: rec.gallery || [],
    performers: rec.performers || null,
    publishedAt: rec.publishedAt || null,
  };
}

export { normPerformers };
