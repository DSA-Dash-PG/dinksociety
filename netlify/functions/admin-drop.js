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
  getDrop, saveDraft, publishDrop, unpublishDrop, listDrops, parseEdition,
} from './lib/drop.js';
import { livePerformers } from './lib/drop-insights.js';
import { appendMessage, generateId } from './lib/messages.js';
import { renderAdminMessage, htmlToPlain } from './lib/email.js';
import { sendNotify } from './lib/notify-prefs.js';

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

// Compose + send the publish broadcast: a portal announcement to every team
// thread plus (optionally) an email to players, both linking to the article.
async function broadcastDrop(rec, { sendEmail: doEmail = true, audience = 'players' } = {}) {
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
  const template = await getEmailTemplate();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let recipients = 0, emailed = 0, failed = 0, skipped = 0, firstError = null;
  const seen = new Set();   // one email per person, even if rostered on two teams

  for (const team of teams) {
    // Portal announcement (shows on player + captain portals via announcements.js).
    await appendMessage({
      teamId: team.id, from: 'admin', authorName: 'The Society Desk',
      authorEmail: rec.sentBy || 'desk@dinksociety.app',
      body: `${subject}\n\n${text}`, bodyHtml, broadcastId,
    });
    if (doEmail) {
      const tos = recipientEmails(team, audience).filter(e => !seen.has(e));
      tos.forEach(e => seen.add(e));
      recipients += tos.length;
      for (const to of tos) {
        try {
          // Through the notify gate: a player who unsubscribed from league
          // broadcasts is skipped, and the manage/unsubscribe footer is added.
          const r = await sendNotify({
            to, category: 'league', subject: `${subject} — The Dink Society`,
            html: renderAdminMessage({ subject, bodyHtml, body: text, teamName: team.name, portalUrl: link, template }),
          });
          if (r && r.skipped) { skipped++; continue; }
          emailed++;
          await sleep(120);  // stay under Resend's per-second send limit on big blasts
        } catch (e) {
          failed++;
          if (!firstError) firstError = e.message || String(e);
          console.error('drop email failed:', e);
        }
      }
    }
  }
  if (doEmail) console.log(`drop broadcast week ${rec.week} [circuit ${rec.circuit}]: ${teams.length} teams, ${recipients} recipients, ${emailed} sent, ${skipped} opted out, ${failed} failed${firstError ? ' · first error: ' + firstError : ''}`);

  // Log to the broadcasts store so it surfaces as a league announcement, gated
  // to players (the recap is for everyone).
  try {
    await getStore('broadcasts').setJSON(`broadcast/${broadcastId}.json`, {
      id: broadcastId, subject, body: text, bodyHtml,
      attachments: [], scope: 'all', division: null, teamIds: null,
      audience: 'players', sentEmail: !!doEmail, teamCount: teams.length,
      recipients, emailed, skipped, failed, firstError,
      sentBy: rec.sentBy || 'desk@dinksociety.app', sentAt: new Date().toISOString(),
      kind: 'drop', dropWeek: rec.week, dropEdition: rec.edition,
    });
  } catch (e) { console.error('drop broadcast log failed:', e); }

  return { broadcastId, circuit: rec.circuit, teamCount: teams.length, recipients, emailed, skipped, failed, firstError };
}

function recipientEmails(team, audience) {
  const roster = team.roster || [];
  const lc = (e) => (e || '').toString().trim().toLowerCase();
  const out = new Set();
  if (audience === 'players') {
    for (const p of roster) if (p.email) out.add(lc(p.email));
    if (team.captainEmail) out.add(lc(team.captainEmail));
  } else {
    if (team.captainEmail) out.add(lc(team.captainEmail));
    const cap = roster.find(p => p.isCaptain);
    if (cap?.email) out.add(lc(cap.email));
  }
  return [...out].filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
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
      const rec = await publishDrop(code, wk, admin.email, performers);
      const channels = body.channels || { email: true, portal: true };
      let broadcast = null;
      if (channels.email || channels.portal) {
        broadcast = await broadcastDrop(rec, { sendEmail: !!channels.email, audience: body.audience || 'players' });
      }
      return json({ ok: true, record: rec, broadcast });
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
