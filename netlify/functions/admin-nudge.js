// netlify/functions/admin-nudge.js
// One-click admin reminders, fired from the Overview "Action required" panel.
//
// POST { type: 'lineups' }   → nudge captains whose lineup isn't locked for the
//                              current week (recomputed server-side — the client
//                              list is never trusted).
// POST { type: 'balance' }   → remind teams/agents with an outstanding balance,
//                              linking to the captain portal Billing tab.
//
// Each nudge appends a message to the team's portal thread (so it shows in the
// message center) AND emails the captain via Resend. Free agents with a balance
// get email only (no team thread).

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { sendEmail, renderAdminMessage } from './lib/email.js';
import { appendMessage } from './lib/messages.js';

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function captainEmails(team) {
  const out = new Set();
  const lc = (e) => (e || '').toString().trim().toLowerCase();
  if (team?.captainEmail) out.add(lc(team.captainEmail));
  const cap = (team?.roster || []).find(p => p.isCaptain);
  if (cap?.email) out.add(lc(cap.email));
  return [...out].filter(e => EMAIL_RE.test(e));
}

async function listAllTeams() {
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = await Promise.all(
    blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  );
  return teams.filter(Boolean);
}

// Send one nudge: portal message (if the team exists) + captain email.
// Returns { messaged: boolean, emailed: number }.
async function deliver({ team, emails, subject, body, adminEmail }) {
  let messaged = false;
  if (team?.id) {
    try {
      await appendMessage({
        teamId: team.id, from: 'admin', authorName: 'League Admin',
        authorEmail: adminEmail, body,
      });
      messaged = true;
    } catch (e) { console.error('nudge message failed:', e); }
  }
  let emailed = 0;
  for (const to of emails) {
    try {
      const r = await sendEmail({
        to, subject,
        html: renderAdminMessage({ subject, body, teamName: team?.name || 'Free agent', portalUrl: `${siteUrl()}/captain.html` }),
      });
      if (r && !r.error) emailed++;
    } catch (e) { console.error('nudge email failed:', e); }
  }
  return { messaged, emailed };
}

// ── Lineup nudge targets: teams without a locked lineup this week ──────────
async function lineupTargets(circuit) {
  const scheduleStore = getStore('schedule');
  const lineupStore = getStore('lineups');

  const { blobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` });
  const weekFiles = {};
  for (const b of blobs) {
    const m = b.key.match(/schedule\/[^/]+\/([^/]+)\/week-(\d+)\.json$/);
    if (!m) continue;
    const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const week = parseInt(m[2], 10);
    (weekFiles[week] = weekFiles[week] || []).push({ division: m[1], data });
  }
  const allWeeks = Object.keys(weekFiles).map(Number).sort((a, b) => a - b);
  if (!allWeeks.length) return { week: null, targets: [] };
  const week = allWeeks.find(w => weekFiles[w].some(f => (f.data.matches || []).some(mt => !mt.finalizedAt)))
    || allWeeks[allWeeks.length - 1];

  const byTeam = new Map(); // teamId → { teamId, name, division, scheduledAt }
  for (const { division, data } of weekFiles[week]) {
    for (const mt of data.matches || []) {
      if (mt.finalizedAt) continue;
      for (const side of ['teamA', 'teamB']) {
        const t = mt[side];
        if (!t?.id || byTeam.has(t.id)) continue;
        const lu = await lineupStore.get(`lineup/${mt.id}/${t.id}.json`, { type: 'json' }).catch(() => null);
        if (!lu?.lockedAt) {
          byTeam.set(t.id, { teamId: t.id, name: t.name || 'Team', division, scheduledAt: mt.scheduledAt || null });
        }
      }
    }
  }
  return { week, targets: [...byTeam.values()] };
}

// ── Balance nudge targets: confirmed registrations still owing ─────────────
async function balanceTargets() {
  const regStore = getStore('registrations');
  const { blobs } = await regStore.list({ prefix: 'confirmed/' });
  const regs = (await Promise.all(
    blobs.map(b => regStore.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(Boolean);

  const out = [];
  for (const r of regs) {
    const due = r?.balanceDue != null
      ? (r.balanceDue || 0)
      : Math.max(0, (r?.totalPrice || r?.price || 0) - (r?.amountPaid || 0));
    if (due <= 0) continue;
    const name = r?.path === 'team' ? (r.team?.name || 'Team') : (r.agent?.name || 'Free agent');
    const contact = r?.path === 'team' ? r.team?.players?.[0]?.email : r.agent?.email;
    out.push({ regId: r.id, path: r.path, name, due: Math.round(due), contact: (contact || '').trim().toLowerCase() });
  }
  return out.sort((a, b) => b.due - a.due);
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const type = body.type;
  const circuit = body.circuit || 'I';

  const teams = await listAllTeams();
  const teamById = new Map(teams.map(t => [t.id, t]));
  const teamByRegId = new Map(teams.filter(t => t.registrationId).map(t => [t.registrationId, t]));

  // ── Lineups ────────────────────────────────────────────────
  if (type === 'lineups') {
    const { week, targets } = await lineupTargets(circuit);
    if (!week || !targets.length) return json({ ok: true, week, sent: [], skipped: [], note: 'All lineups locked.' });

    const sent = [], skipped = [];
    for (const t of targets) {
      const team = teamById.get(t.teamId) || null;
      const emails = captainEmails(team);
      const when = t.scheduledAt
        ? new Date(t.scheduledAt).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit' })
        : null;
      const msg = `Reminder: your Week ${week} lineup isn't locked yet.\n\n`
        + `Lineups lock 1 hour before first serve${when ? ` (your match: ${when})` : ''} — after that the league locks it for you. `
        + `Open the captain portal, set your lineup, and hit Lock.`;
      const r = await deliver({
        team, emails, adminEmail: admin.email, body: msg,
        subject: `Lock your Week ${week} lineup — ${t.name}`,
      });
      if (r.messaged || r.emailed) sent.push({ name: t.name, division: t.division, emailed: r.emailed, messaged: r.messaged });
      else skipped.push({ name: t.name, division: t.division, reason: emails.length ? 'send failed' : 'no captain email' });
    }
    return json({ ok: true, week, sent, skipped });
  }

  // ── Balance ────────────────────────────────────────────────
  if (type === 'balance') {
    const targets = await balanceTargets();
    if (!targets.length) return json({ ok: true, sent: [], skipped: [], note: 'No outstanding balances.' });

    const sent = [], skipped = [];
    for (const t of targets) {
      const team = t.path === 'team' ? (teamByRegId.get(t.regId) || null) : null;
      const emails = new Set(team ? captainEmails(team) : []);
      if (t.contact && EMAIL_RE.test(t.contact)) emails.add(t.contact);
      const tos = [...emails];
      const msg = `Friendly reminder: ${t.name} has an outstanding league balance of $${t.due.toLocaleString()}.\n\n`
        + `You can pay online in the captain portal — open the Billing tab and pay by card in about a minute. `
        + `Zelle, Venmo, or cash at league night work too; just let us know so we can mark it received.`;
      const r = await deliver({
        team, emails: tos, adminEmail: admin.email, body: msg,
        subject: `Balance due: $${t.due.toLocaleString()} — ${t.name}`,
      });
      if (r.messaged || r.emailed) sent.push({ name: t.name, due: t.due, emailed: r.emailed, messaged: r.messaged });
      else skipped.push({ name: t.name, due: t.due, reason: tos.length ? 'send failed' : 'no contact email' });
    }
    return json({ ok: true, sent, skipped });
  }

  return json({ error: `Unknown type: ${type}` }, 400);
};

export const config = { path: '/.netlify/functions/admin-nudge' };
