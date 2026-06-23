// netlify/functions/admin-messages.js
// Admin side of the message center.
//
// GET                         → inbox: every team with last message + unread count
// GET  ?teamId=<id>           → full thread for one team (+ marks it read for admin)
// POST action=reply           body: { teamId, body, sendEmail? }
// POST action=broadcast       body: { subject?, body, scope, division?, teamIds?, audience, sendEmail? }
//   scope:    'all' | 'division' | 'teams'
//   audience: 'captains' | 'cocaptains' | 'players'   (who gets the EMAIL)
// POST action=mark-read       body: { teamId }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import {
  sendEmail, renderAdminMessage, sanitizeMessageHtml, messageLooksHtml, htmlToPlain,
} from './lib/email.js';
import {
  listThread, appendMessage, getReads, setRead, unreadCount, generateId,
} from './lib/messages.js';

// Load the admin-configured email appearance (logo/accent/header/button/footer).
async function getEmailTemplate() {
  try {
    const raw = await getStore({ name: 'config', consistency: 'strong' }).get('circuit-settings');
    const s = raw ? JSON.parse(raw) : {};
    return s.emailTemplate || null;
  } catch { return null; }
}

// Resolve stored attachment ids → metadata + absolute serve URLs.
async function resolveAttachments(ids, site) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const store = getStore('broadcast-files');
  const metas = await Promise.all(ids
    .filter(id => /^[a-f0-9]{16}$/.test(String(id)))
    .map(id => store.get(`meta/${id}.json`, { type: 'json' }).catch(() => null)));
  return metas.filter(Boolean).map(m => ({
    id: m.id, filename: m.filename, size: m.size, contentType: m.contentType,
    url: `${site}/.netlify/functions/broadcast-files-serve?id=${m.id}&dl=1`,
  }));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

async function listAllTeams() {
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = await Promise.all(
    blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  );
  return teams.filter(Boolean);
}

// Resolve which email addresses to notify for a team, given the audience.
function recipientEmails(team, audience) {
  const roster = team.roster || [];
  const lc = (e) => (e || '').toString().trim().toLowerCase();
  // Canonical roster email lives in normalizedEmail (stamped on save); the raw
  // `email` field is often blank. Read both, matching the rest of the codebase.
  const emailOf = (p) => p && (p.normalizedEmail || p.email);
  const out = new Set();
  if (audience === 'players') {
    for (const p of roster) { const e = emailOf(p); if (e) out.add(lc(e)); }
    if (team.captainEmail) out.add(lc(team.captainEmail));
  } else if (audience === 'cocaptains') {
    const cap = roster.find(p => p.isCaptain);
    const co = roster.find(p => p.isCoCaptain);
    if (team.captainEmail) out.add(lc(team.captainEmail));
    if (emailOf(cap)) out.add(lc(emailOf(cap)));
    if (emailOf(co)) out.add(lc(emailOf(co)));
  } else { // 'captains'
    if (team.captainEmail) out.add(lc(team.captainEmail));
    const cap = roster.find(p => p.isCaptain);
    if (emailOf(cap)) out.add(lc(emailOf(cap)));
  }
  return [...out].filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);

  // ── GET ────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const teamId = url.searchParams.get('teamId');

    if (teamId) {
      const teamsStore = getStore('teams');
      const team = await teamsStore.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
      const messages = await listThread(teamId);
      const reads = await getReads(teamId); // captainReadAt drives admin's read receipts
      await setRead(teamId, 'admin'); // viewing a thread clears admin unread
      return json({
        team: team ? { id: team.id, name: team.name, captainEmail: team.captainEmail || null,
          division: team.division, divisionLabel: team.divisionLabel } : { id: teamId },
        messages,
        // For read receipts: when the captain last read. An admin's own message
        // is "read" once captainReadAt is after it was sent.
        reads: { captainReadAt: reads.captainReadAt || null, adminReadAt: reads.adminReadAt || null },
      });
    }

    // Inbox overview
    const teams = await listAllTeams();
    const rows = await Promise.all(teams.map(async (t) => {
      const messages = await listThread(t.id);
      const reads = await getReads(t.id);
      const last = messages[messages.length - 1] || null;
      return {
        teamId: t.id,
        teamName: t.name,
        division: t.division || null,
        divisionLabel: t.divisionLabel || null,
        captainEmail: t.captainEmail || null,
        messageCount: messages.length,
        unread: unreadCount(messages, reads, 'admin'),
        lastBody: last ? last.body.slice(0, 120) : null,
        lastFrom: last ? last.from : null,
        lastAt: last ? last.createdAt : null,
      };
    }));
    rows.sort((a, b) => {
      if (b.unread !== a.unread) return b.unread - a.unread;
      return (b.lastAt || '').localeCompare(a.lastAt || '');
    });
    const totalUnread = rows.reduce((s, r) => s + r.unread, 0);
    return json({ inbox: rows, totalUnread });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const action = body.action;

  // ── Reply to one team ──────────────────────────────────────
  if (action === 'reply') {
    const { teamId, body: text, sendEmail: doEmail } = body;
    if (!teamId || !text?.trim()) return json({ error: 'teamId and body required' }, 400);

    const teamsStore = getStore('teams');
    const team = await teamsStore.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
    if (!team) return json({ error: 'Team not found' }, 404);

    const msg = await appendMessage({
      teamId, from: 'admin', authorName: 'League Admin', authorEmail: admin.email, body: text,
    });
    await setRead(teamId, 'admin');

    let emailed = 0;
    if (doEmail) {
      const template = await getEmailTemplate();
      const tos = recipientEmails(team, 'captains');
      for (const to of tos) {
        try {
          await sendEmail({
            to,
            subject: `Message from The Dink Society — ${team.name}`,
            html: renderAdminMessage({ body: text, teamName: team.name, portalUrl: `${siteUrl()}/captain.html`, template }),
          });
          emailed++;
        } catch (e) { console.error('reply email failed:', e); }
      }
    }
    return json({ ok: true, message: msg, emailed });
  }

  // ── Broadcast to many teams ────────────────────────────────
  if (action === 'broadcast') {
    const {
      subject, body: rawText, bodyHtml: rawHtml, scope, division, teamIds,
      audience = 'captains', sendEmail: doEmail, attachmentIds,
    } = body;

    // Rich body (sanitized) takes precedence; derive a plain-text copy for
    // previews/fallback. Either a body or at least one attachment is required.
    const safeHtml = (typeof rawHtml === 'string' && messageLooksHtml(rawHtml))
      ? sanitizeMessageHtml(rawHtml) : '';
    const text = (rawText && rawText.trim())
      ? rawText.trim()
      : (safeHtml ? htmlToPlain(safeHtml) : '');

    const site = siteUrl();
    const attachments = await resolveAttachments(attachmentIds, site);

    if (!text && !attachments.length) {
      return json({ error: 'Add a message or at least one attachment.' }, 400);
    }

    const all = await listAllTeams();
    let targets;
    if (scope === 'teams') {
      const set = new Set(teamIds || []);
      targets = all.filter(t => set.has(t.id));
    } else if (scope === 'division') {
      targets = all.filter(t => t.division === division);
    } else { // 'all'
      targets = all;
    }
    if (!targets.length) return json({ error: 'No teams matched the targeting.' }, 400);

    const template = await getEmailTemplate();
    // Resend attachments fetch each file by hosted URL at send time.
    const mailAttachments = attachments.map(a => ({ filename: a.filename, path: a.url }));

    const broadcastId = generateId('bc_');
    // Stored thread body keeps the subject inline (plain) for legacy readers;
    // bodyHtml carries the rich version when present.
    const composedBody = subject?.trim() && text ? `${subject.trim()}\n\n${text}` : text;
    let emailed = 0;
    for (const team of targets) {
      await appendMessage({
        teamId: team.id, from: 'admin', authorName: 'League Admin',
        authorEmail: admin.email, body: composedBody, bodyHtml: safeHtml || null,
        attachments, broadcastId,
      });
      if (doEmail) {
        const tos = recipientEmails(team, audience);
        for (const to of tos) {
          try {
            await sendEmail({
              to,
              subject: subject?.trim() ? `${subject.trim()} — The Dink Society` : `Update from The Dink Society`,
              html: renderAdminMessage({
                subject, bodyHtml: safeHtml, body: text, teamName: team.name,
                portalUrl: `${site}/captain.html`, template, attachments,
              }),
              attachments: mailAttachments,
            });
            emailed++;
          } catch (e) { console.error('broadcast email failed:', e); }
        }
      }
    }

    // Log the broadcast
    try {
      await getStore('broadcasts').setJSON(`broadcast/${broadcastId}.json`, {
        id: broadcastId, subject: subject || null, body: text, bodyHtml: safeHtml || null,
        attachments, scope, division: division || null,
        teamIds: scope === 'teams' ? (teamIds || []) : null, audience, sentEmail: !!doEmail,
        teamCount: targets.length, emailed, sentBy: admin.email, sentAt: new Date().toISOString(),
      });
    } catch (e) { console.error('broadcast log failed:', e); }

    return json({ ok: true, broadcastId, teamCount: targets.length, emailed });
  }

  // ── Mark a thread read ─────────────────────────────────────
  if (action === 'mark-read') {
    const { teamId } = body;
    if (!teamId) return json({ error: 'teamId required' }, 400);
    await setRead(teamId, 'admin');
    return json({ ok: true });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
};

export const config = { path: '/.netlify/functions/admin-messages' };
