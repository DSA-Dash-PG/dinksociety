// netlify/functions/admin-drop.js
// Admin side of "The Drop" weekly editorial.
//
//   GET                        → list every week's Drop for the circuit (status + titles)
//   GET ?week=N                → full record for one week (draft or published)
//   POST action=save-draft     → upsert the editorial for a week (stays/creates draft)
//   POST action=publish        → approve + go live: mark published, snapshot performers,
//                                fire the email + portal broadcast (homepage reads it live)
//   POST action=unpublish      → pull a published Drop back to draft
//
//   POST action=receive-draft  → INGEST a machine-generated draft from the weekly
//                                scheduled task. Guarded by the DROP_INGEST_TOKEN env
//                                (header `x-drop-token`) instead of an admin session,
//                                so the task can post without a browser login. Always
//                                lands as a DRAFT — nothing auto-publishes.
//
// Query/body `circuit` defaults to 'I' (the live season), consistent with the
// public endpoints. Performers for publish are pulled fresh from the standings
// aggregate so the snapshot matches what the recap shows.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import {
  getDrop, saveDraft, publishDrop, unpublishDrop, listDrops, parseEdition, markBroadcast,
} from './lib/drop.js';
import { livePerformers } from './lib/drop-insights.js';
import { appendMessage, generateId } from './lib/messages.js';
import { renderAdminMessage, htmlToPlain } from './lib/email.js';
import { activeRoster } from './lib/roster.js';
import { normalizeEmail } from './lib/identity.js';
import { listRosterEntries, getIdentityMap, groupEntries } from './lib/league-identity.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

function ingestToken() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('DROP_INGEST_TOKEN'))
    || process.env.DROP_INGEST_TOKEN || '';
}

async function getEmailTemplate() {
  try {
    const raw = await getStore({ name: 'config', consistency: 'strong' }).get('circuit-settings');
    const s = raw ? JSON.parse(raw) : {};
    return s.emailTemplate || null;
  } catch { return null; }
}

// Teams for ONE season only. The teams store holds every season side by side,
// and a Drop broadcast that walked all of them would email Season 1 rosters
// about Season 2 — so match on the resolved circuit code (a team's `circuit`
// or `seasonId`, whichever it carries).
async function listSeasonTeams(circuit) {
  const code = circuitCode(circuit);
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
  return teams.filter(t => t && circuitCode(t.circuit || t.seasonId) === code);
}

// An edition id: `week-<n>` (or a bare number) for a numbered week, or a slug
// such as `preseason` / `championship-preview`. Bodies may send either
// `edition` (preferred) or the legacy `week`.
function editionOf(body) {
  const ed = parseEdition(body?.edition ?? body?.week);
  return ed ? ed.id : null;
}

// Compose + fire the publish broadcast: a portal announcement to every team
// thread (inline — six writes, fast) plus the player emails, which are queued
// to admin-broadcast-email-background. Sending ~70 emails inline blew through
// the 10s function limit: the request 504'd, the admin saw "Publish failed",
// clicked again, and every captain got the announcement twice a minute apart.
async function broadcastDrop(rec, req, { sendEmail: doEmail = true, audience = 'players' } = {}) {
  const site = siteUrl();
  const link = `${site}/drop.html?edition=${encodeURIComponent(rec.edition)}`;
  const subject = rec.kicker || `The Drop · ${rec.label || 'Week ' + rec.week}`;
  const teaser = rec.dek || htmlToPlain(rec.leadHtml || '').slice(0, 200);
  const text = `${rec.title}\n\n${teaser}\n\nRead the full Drop: ${link}`;
  const coverHtml = (rec.cover && rec.cover.id)
    ? `<p><a href="${link}"><img src="${site}/.netlify/functions/drop-photo-serve?id=${encodeURIComponent(rec.cover.id)}" alt="" style="width:100%;max-width:560px;height:auto;border-radius:10px;"></a></p>`
    : '';
  const bodyHtml = coverHtml
    + `<p><strong>${escapeHtml(rec.title)}</strong></p>`
    + (teaser ? `<p>${escapeHtml(teaser)}</p>` : '')
    + `<p><a href="${link}">Read the full Drop →</a></p>`;

  const teams = await listSeasonTeams(rec.circuit);
  const broadcastId = generateId('bc_');

  for (const team of teams) {
    // Portal announcement (shows on player + captain portals via announcements.js).
    await appendMessage({
      teamId: team.id, from: 'admin', authorName: 'The Society Desk',
      authorEmail: rec.sentBy || 'desk@dinksociety.app',
      body: `${subject}\n\n${text}`, bodyHtml, broadcastId,
    });
  }

  // Resolve every team's recipient list ONCE, here, and pin it on the record.
  // Week 1 of Season 2 went out as "emailed 0/0 across 6 teams": the old
  // per-team lookup read only `p.email`, but Season 2 roster entries carry the
  // address in `normalizedEmail` (or nowhere at all — players added through
  // the picker only have an email on their Season 1 entry). So the count came
  // back 0, the background sender was never kicked off, and nobody got the
  // Drop. The list below reads both fields and falls back to the person's
  // other roster entries via the identity layer; the sender uses the same
  // list, so the count and the send can't disagree again.
  const resolved = await resolveRecipients(teams, audience);
  const seen = new Set();
  for (const list of Object.values(resolved.byTeam)) for (const e of list) seen.add(e);
  const recipients = doEmail ? seen.size : 0;
  const noEmail = resolved.noEmail;

  // The broadcast record is both the announcement log and the work order for
  // the background sender (same shape admin-messages uses).
  await getStore('broadcasts').setJSON(`broadcast/${broadcastId}.json`, {
    id: broadcastId, subject, body: text, bodyHtml,
    attachments: [], scope: 'all', division: null,
    teamIds: teams.map(t => t.id), audience, sentEmail: !!doEmail,
    recipientsByTeam: resolved.byTeam, noEmail, noEmailNames: resolved.noEmailNames,
    teamCount: teams.length, recipients, emailed: 0, failed: 0, optedOut: 0,
    emailStatus: doEmail ? (recipients ? 'queued' : 'none') : 'none',
    sentBy: rec.sentBy || 'desk@dinksociety.app', sentAt: new Date().toISOString(),
    kind: 'drop', dropWeek: rec.week, dropEdition: rec.edition, circuit: rec.circuit,
  });

  let queued = false;
  if (doEmail && recipients) {
    try {
      const r = await fetch(`${site}/.netlify/functions/admin-broadcast-email-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: req.headers.get('cookie') || '' },
        body: JSON.stringify({ broadcastId }),
      });
      queued = r.status === 202 || r.ok;
      if (!queued) console.error('drop background email kick-off failed:', r.status);
    } catch (e) { console.error('drop background email kick-off failed:', e); }
  }
  console.log(`drop broadcast ${rec.edition} [circuit ${rec.circuit}]: ${teams.length} teams, ${recipients} recipients, ${noEmail} without an email, email ${queued ? 'queued' : (doEmail ? 'NOT queued' : 'off')}`);
  return { broadcastId, circuit: rec.circuit, teamCount: teams.length, recipients, noEmail, noEmailNames: resolved.noEmailNames, queued, emailed: 0, failed: 0 };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Per-team recipient lists for a Drop broadcast.
//
// Returns { byTeam: { [teamId]: [email, …] }, noEmail, noEmailNames }.
//
// Who: the team's ACTIVE roster (lib/roster.js — archived players and pending
// adds are not on the team) plus the captain address on the team record.
// Which address: `normalizedEmail` first, then raw `email`; if the entry has
// neither, any other roster entry the identity layer says is the same person
// (their Season 1 entry, a linked id). Whoever still has no address is counted
// in `noEmail` so the admin status line can say so instead of hiding it.
async function resolveRecipients(teams, audience) {
  // id → email for every roster entry across every season, grouped into people.
  let idsFor = (id) => [id];
  const emailById = new Map();
  try {
    const [entries, map] = await Promise.all([listRosterEntries(), getIdentityMap()]);
    for (const e of entries) {
      const em = e.normalizedEmail || normalizeEmail(e.email);
      if (em && EMAIL_RE.test(em)) emailById.set(e.id, em);
    }
    const { canonicalOf, membersOf } = groupEntries(entries, map);
    idsFor = (id) => { const c = canonicalOf[id]; return c ? (membersOf[c] || [id]) : [id]; };
  } catch (e) {
    console.error('drop recipients: identity lookup failed, using roster emails only:', e.message);
  }
  const emailOf = (p) => {
    const direct = p.normalizedEmail || normalizeEmail(p.email);
    if (direct && EMAIL_RE.test(direct)) return direct;
    for (const id of idsFor(p.id)) { const em = emailById.get(id); if (em) return em; }
    return null;
  };

  const byTeam = {};
  let noEmail = 0; const noEmailNames = [];
  for (const team of teams) {
    const roster = activeRoster(team);
    const out = new Set();
    const cap = normalizeEmail(team.captainEmail);
    if (cap && EMAIL_RE.test(cap)) out.add(cap);
    const want = audience === 'players'
      ? roster
      : audience === 'cocaptains'
        ? roster.filter(p => p.isCaptain || p.isCoCaptain)
        : roster.filter(p => p.isCaptain);
    for (const p of want) {
      const em = emailOf(p);
      if (em) out.add(em);
      else { noEmail++; noEmailNames.push(`${p.name || p.id} (${team.name || team.id})`); }
    }
    byTeam[team.id] = [...out];
  }
  return { byTeam, noEmail, noEmailNames };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async (req) => {
  const url = new URL(req.url);
  const circuit = (url.searchParams.get('circuit') || 'I').trim();

  // ── Token-guarded ingest from the weekly scheduled task ──────
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    if (body.action === 'receive-draft') {
      const expected = ingestToken();
      const given = req.headers.get('x-drop-token') || body.token || '';
      if (!expected || given !== expected) return json({ error: 'Bad or missing ingest token' }, 401);
      const wk = editionOf(body);
      if (wk == null) return json({ error: 'edition (or week) required' }, 400);
      const rec = await saveDraft(body.circuit || circuit, wk, { ...body, generatedBy: 'auto' }, 'scheduled-task');
      return json({ ok: true, status: rec.status, edition: rec.edition, week: rec.week, circuit: rec.circuit });
    }

    // Everything else is admin-only.
    const verified = await verifyAdminSession(req);
    if (!verified.valid) return unauthResponse(verified.error);
    const admin = verified.payload;

    if (body.action === 'save-draft') {
      const wk = editionOf(body);
      if (wk == null) return json({ error: 'edition (or week) required' }, 400);
      const rec = await saveDraft(body.circuit || circuit, wk, body, admin.email);
      return json({ ok: true, record: rec });
    }

    if (body.action === 'publish') {
      const wk = editionOf(body);
      if (wk == null) return json({ error: 'edition (or week) required' }, 400);
      const code = circuitCode(body.circuit || circuit);
      const existing = await getDrop(code, wk);
      if (!existing) return json({ error: 'No draft to publish for that edition' }, 404);
      // If the composer sent edits, persist them first.
      if (body.title || body.leadHtml || body.storylines || body.cover || body.gallery) {
        await saveDraft(code, wk, body, admin.email);
      }
      const performers = await livePerformers(code);
      const channels = body.channels || { email: true, portal: true };
      // Idempotent: a second Publish on an edition that already broadcast is a
      // no-op unless the admin explicitly asks to re-notify (rebroadcast:true).
      const alreadyBroadcast = existing.status === 'published' && !!existing.broadcastId;
      const wantBroadcast = (channels.email || channels.portal) && (!alreadyBroadcast || body.rebroadcast === true);
      let rec = await publishDrop(code, wk, admin.email, performers);
      let broadcast = null;
      if (wantBroadcast) {
        broadcast = await broadcastDrop(rec, req, { sendEmail: !!channels.email, audience: body.audience || 'players' });
        rec = (await markBroadcast(code, wk, broadcast.broadcastId)) || rec;
      }
      return json({ ok: true, record: rec, broadcast, alreadyBroadcast: alreadyBroadcast && !wantBroadcast });
    }

    if (body.action === 'unpublish') {
      const wk = editionOf(body);
      if (wk == null) return json({ error: 'edition (or week) required' }, 400);
      const rec = await unpublishDrop(body.circuit || circuit, wk);
      return json({ ok: true, record: rec });
    }

    return json({ error: `Unknown action: ${body.action}` }, 400);
  }

  // ── GET (admin only) ─────────────────────────────────────────
  if (req.method === 'GET') {
    const verified = await verifyAdminSession(req);
    if (!verified.valid) return unauthResponse(verified.error);

    const ed = parseEdition(url.searchParams.get('edition') ?? url.searchParams.get('week'));
    if (ed) {
      const rec = await getDrop(circuit, ed.id);
      // Attach a live performers preview so the composer can show what will be snapshotted.
      const preview = await livePerformers(circuit);
      return json({ record: rec, livePerformers: preview });
    }
    const recs = await listDrops(circuit);
    return json({
      circuit: circuitCode(circuit),
      weeks: recs.map(r => ({
        edition: r.edition, week: r.week, label: r.label, short: r.short, order: r.order, after: r.after ?? null,
        status: r.status, title: r.title,
        updatedAt: r.updatedAt, publishedAt: r.publishedAt, generatedBy: r.generatedBy,
      })),
    });
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/admin-drop' };
