// netlify/functions/admin-welcome-correction.js
//
// ONE-OFF FOLLOW-UP for the roster-welcome email that hardcoded "Monday".
//
// Season 1 played Mondays and the welcome said so in four places. Season 2
// plays Thursdays, and everyone added to a Season 2 roster before the fix was
// told the wrong night. This finds them and sends a short correction.
//
// Who qualifies: an active roster player (not pending, not archived), with an
// email, welcomed within the window (`welcomedAt`), on a non-test team whose
// season resolves to a league night that is NOT Monday — a player whose season
// really does play Mondays was told the truth and is left alone. Each player is
// corrected once: `welcomeCorrectedAt` is stamped after a successful send.
//
// GET  ?days=14 → { recipients:[…], alreadySent:n, skippedMonday:n, days }
// POST { days } → sends to every recipient the GET would list → { sent, failed }

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { createPlayerToken } from './lib/player-auth.js';
import { sendEmail, renderWelcomeCorrection, welcomeCorrectionSubject } from './lib/email.js';
import { leagueNightFor } from './lib/roster-welcome.js';
import { normalizeEmail } from './lib/identity.js';
import { seasonName, isTestTeam } from './lib/circuit.js';

const DEFAULT_DAYS = 14;
const MAX_DAYS = 60;
const TOKEN_DAYS = 7;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.app';
}

function windowDays(raw) {
  const n = parseInt(raw, 10);
  if (!(n > 0)) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

/** Every player who should get the correction, plus counts of who was skipped and why. */
async function findRecipients(days) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const teams = getStore('teams');
  const { blobs } = await teams.list({ prefix: 'team/' });

  const recipients = [];
  let alreadySent = 0, skippedMonday = 0, noNight = 0;
  const nightCache = new Map();

  for (const b of blobs || []) {
    const team = await teams.get(b.key, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!team || isTestTeam(team)) continue;

    const welcomed = (team.roster || []).filter(p =>
      p && !p.pendingAdd && !p.archived && p.welcomedAt
      && new Date(p.welcomedAt).getTime() >= since
      && normalizeEmail(p.email));
    if (!welcomed.length) continue;

    const nightKey = team.seasonId || team.circuit || '';
    if (!nightCache.has(nightKey)) nightCache.set(nightKey, await leagueNightFor(team));
    const night = nightCache.get(nightKey);

    if (!night.dayName) { noNight += welcomed.length; continue; }
    if (night.dayName === 'Monday') { skippedMonday += welcomed.length; continue; }

    for (const p of welcomed) {
      if (p.welcomeCorrectedAt) { alreadySent++; continue; }
      recipients.push({
        teamId: team.id, teamKey: b.key, teamName: team.name || 'your team',
        seasonName: seasonName(team.circuit || team.seasonId),
        playerId: p.id, name: p.name || '', email: normalizeEmail(p.email),
        welcomedAt: p.welcomedAt, night,
      });
    }
  }

  recipients.sort((a, b) => String(b.welcomedAt).localeCompare(String(a.welcomedAt)));
  return { recipients, alreadySent, skippedMonday, noNight };
}

export default async (req) => {
  const admin = await verifyAdminSession(req);
  if (!admin.valid) return unauthResponse(admin.error);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const days = windowDays(url.searchParams.get('days'));
    const found = await findRecipients(days);
    return json({
      days,
      count: found.recipients.length,
      alreadySent: found.alreadySent,
      skippedMonday: found.skippedMonday,
      noNight: found.noNight,
      recipients: found.recipients.map(({ teamKey, ...r }) => r),
    });
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }
    const days = windowDays(body.days);
    const { recipients } = await findRecipients(days);
    if (!recipients.length) return json({ days, sent: 0, failed: 0, results: [] });

    const site = siteUrl();
    const teams = getStore('teams');
    const results = [];
    const stampedByTeam = new Map();   // teamKey → Set(playerId)

    for (const r of recipients) {
      try {
        const token = await createPlayerToken({
          email: r.email, playerId: r.playerId, teamId: r.teamId,
          minutes: TOKEN_DAYS * 24 * 60,
        });
        const html = renderWelcomeCorrection({
          playerName: r.name, teamName: r.teamName, seasonName: r.seasonName,
          dayName: r.night.dayName, time: r.night.time, venue: r.night.venue,
          weeks: (r.night.when.match(/(\d+) weeks/) || [])[1] || '',
          magicUrl: `${site}/.netlify/functions/player-link?token=${token}`,
          siteUrl: site,
        });
        await sendEmail({
          to: r.email,
          subject: welcomeCorrectionSubject({ dayName: r.night.dayName, seasonName: r.seasonName }),
          html,
          replyTo: 'dink@dinksociety.app',
        });
        if (!stampedByTeam.has(r.teamKey)) stampedByTeam.set(r.teamKey, new Set());
        stampedByTeam.get(r.teamKey).add(r.playerId);
        results.push({ playerId: r.playerId, name: r.name, email: r.email, ok: true });
      } catch (err) {
        console.error(`welcome-correction failed for ${r.playerId}:`, err?.message || err);
        results.push({ playerId: r.playerId, name: r.name, email: r.email, ok: false, error: err?.message || String(err) });
      }
    }

    // Stamp only the ones that went out. Re-read each team so this can't
    // clobber a roster edit made while the emails were in flight.
    const now = new Date().toISOString();
    for (const [teamKey, ids] of stampedByTeam) {
      try {
        const fresh = await teams.get(teamKey, { type: 'json', consistency: 'strong' }).catch(() => null);
        if (!fresh) continue;
        let touched = false;
        for (const p of (fresh.roster || [])) {
          if (p && ids.has(p.id) && !p.welcomeCorrectedAt) { p.welcomeCorrectedAt = now; touched = true; }
        }
        if (touched) await teams.setJSON(teamKey, fresh);
      } catch (err) {
        console.error('welcome-correction stamp failed:', err?.message || err);
      }
    }

    // Audit trail, same idea as the ladder-messages log.
    try {
      await getStore('admin-messages').setJSON(`welcome-correction/${Date.now()}.json`, {
        sentBy: admin.payload?.email || null, sentAt: now, days,
        sent: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length,
        recipients: results,
      });
    } catch { /* best effort */ }

    return json({
      days,
      sent: results.filter(x => x.ok).length,
      failed: results.filter(x => !x.ok).length,
      results,
    });
  }

  return json({ error: 'Method not allowed' }, 405);
};

export const config = { path: '/.netlify/functions/admin-welcome-correction' };
