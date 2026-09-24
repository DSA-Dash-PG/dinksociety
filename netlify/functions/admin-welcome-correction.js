// netlify/functions/admin-welcome-correction.js
//
// ONE-OFF FOLLOW-UP for the roster-welcome email that hardcoded "Monday".
//
// Season 1 played Mondays and the welcome said so in four places. Season 2
// plays Thursdays, and everyone added to a Season 2 roster before the fix was
// told the wrong night. This finds them and sends a short correction.
//
// Who qualifies: an active roster player (not pending, not archived), with an
// email, welcomed within the window, on a non-test team whose season resolves
// to a league night that is NOT Monday — a player whose season really does
// play Mondays was told the truth and is left alone. Each player is corrected
// once: `welcomeCorrectedAt` is stamped after a successful send.
//
// "Welcomed within the window" comes from TWO sources, because the roster
// entry's `welcomedAt` stamp turned out to be unreliable — until 2026-09-24
// every roster save (captain editor, admin roster replace) rebuilt each entry
// and dropped it. So besides the stamp, this asks Resend for every email sent
// in the window and picks out the welcomes by subject. That is ground truth:
// if Resend delivered a welcome to an address, the person at that address
// saw "Monday". Resend lookups are best-effort; when the API is unreachable
// the response says so and the stamp-only list is returned.
//
// GET  ?days=14 → { recipients:[…], alreadySent:n, skippedMonday:n, days }
// GET  ?find=marta → every roster entry whose name/email matches, with the
//                    fields the filter looks at and WHY each one is in or out.
//                    For "she got the email but she's not on the list".
// POST { days, include?:["teamId:playerId"] } → sends to every recipient the
//      GET would list, plus any `include` entries forced in by the admin (they
//      still need an email and must not be pending/archived/already corrected).

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

// Subjects roster-welcome sends (lib/email.js rosterWelcomeSubject) and the
// one this endpoint sends. Matched by prefix so team/season names don't matter.
const WELCOME_SUBJECT_RE = /^(Welcome to The Dink Society — you’re on |You’re back — )/;
const CORRECTION_SUBJECT_RE = /^Correction(:| to your )/;
const RESEND_PAGE = 100;
const RESEND_MAX_PAGES = 30;   // 3,000 emails — far more than a fortnight of league mail

function resendKey() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('RESEND_API_KEY')) || process.env.RESEND_API_KEY || '';
}

/**
 * Every welcome / correction Resend sent since `since`, keyed by lowercased
 * recipient. Walks GET /emails newest-first until it passes the window.
 * Returns { ok, welcomes: Map<email, {sentAt, subject}>, corrections: Set<email>, scanned }.
 */
async function resendHistory(since) {
  const key = resendKey();
  const out = { ok: false, welcomes: new Map(), corrections: new Set(), scanned: 0, error: null };
  if (!key) { out.error = 'RESEND_API_KEY not set'; return out; }
  let after = null;
  try {
    for (let page = 0; page < RESEND_MAX_PAGES; page++) {
      const url = new URL('https://api.resend.com/emails');
      url.searchParams.set('limit', String(RESEND_PAGE));
      if (after) url.searchParams.set('after', after);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) { out.error = `Resend ${r.status}: ${(await r.text()).slice(0, 200)}`; return out; }
      const body = await r.json();
      const rows = Array.isArray(body?.data) ? body.data : [];
      if (!rows.length) break;
      let pastWindow = false;
      for (const e of rows) {
        out.scanned++;
        const at = Date.parse(e.created_at || '');
        if (Number.isFinite(at) && at < since) { pastWindow = true; continue; }
        const subject = String(e.subject || '');
        const tos = Array.isArray(e.to) ? e.to : [e.to];
        for (const raw of tos) {
          const email = normalizeEmail(String(raw || '').replace(/^.*<([^>]+)>.*$/, '$1'));
          if (!email) continue;
          if (WELCOME_SUBJECT_RE.test(subject)) {
            const prev = out.welcomes.get(email);
            if (!prev || at > Date.parse(prev.sentAt)) out.welcomes.set(email, { sentAt: e.created_at, subject });
          } else if (CORRECTION_SUBJECT_RE.test(subject)) {
            out.corrections.add(email);
          }
        }
      }
      if (pastWindow || body.has_more === false) break;
      after = rows[rows.length - 1]?.id;
      if (!after) break;
    }
    out.ok = true;
  } catch (err) {
    out.error = err?.message || String(err);
  }
  return out;
}

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
  const history = await resendHistory(since);
  const teams = getStore('teams');
  const { blobs } = await teams.list({ prefix: 'team/' });

  const recipients = [];
  let alreadySent = 0, skippedMonday = 0, noNight = 0;
  const nightCache = new Map();

  for (const b of blobs || []) {
    const team = await teams.get(b.key, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!team || isTestTeam(team)) continue;

    // Welcomed = stamped in the window, OR Resend says a welcome went to their
    // address in the window. Either one is enough — the stamp can be missing
    // (wiped by a roster save) and Resend can be unreachable.
    const welcomed = [];
    for (const p of (team.roster || [])) {
      if (!p || p.pendingAdd || p.archived) continue;
      const email = normalizeEmail(p.email);
      if (!email) continue;
      const stamped = p.welcomedAt && new Date(p.welcomedAt).getTime() >= since;
      const sent = history.welcomes.get(email);
      if (!stamped && !sent) continue;
      welcomed.push({ p, email, welcomedAt: p.welcomedAt || sent?.sentAt || null, source: stamped ? 'stamp' : 'resend' });
    }
    if (!welcomed.length) continue;

    const nightKey = team.seasonId || team.circuit || '';
    if (!nightCache.has(nightKey)) nightCache.set(nightKey, await leagueNightFor(team));
    const night = nightCache.get(nightKey);

    if (!night.dayName) { noNight += welcomed.length; continue; }
    if (night.dayName === 'Monday') { skippedMonday += welcomed.length; continue; }

    for (const { p, email, welcomedAt, source } of welcomed) {
      if (p.welcomeCorrectedAt || history.corrections.has(email)) { alreadySent++; continue; }
      recipients.push({
        teamId: team.id, teamKey: b.key, teamName: team.name || 'your team',
        seasonName: seasonName(team.circuit || team.seasonId),
        playerId: p.id, name: p.name || '', email,
        welcomedAt, source, night,
      });
    }
  }

  recipients.sort((a, b) => String(b.welcomedAt).localeCompare(String(a.welcomedAt)));
  return {
    recipients, alreadySent, skippedMonday, noNight,
    history: { ok: history.ok, error: history.error, scanned: history.scanned, welcomes: history.welcomes.size, corrections: history.corrections.size },
  };
}

/**
 * Why is (or isn't) this person on the list? Every roster entry matching the
 * query, across all teams, with the exact fields the filter reads.
 */
async function explain(query, days) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const history = await resendHistory(since);
  const teams = getStore('teams');
  const { blobs } = await teams.list({ prefix: 'team/' });
  const out = [];
  const nightCache = new Map();

  for (const b of blobs || []) {
    const team = await teams.get(b.key, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!team) continue;
    for (const p of (team.roster || [])) {
      if (!p) continue;
      const hay = `${p.name || ''} ${p.email || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;

      const nightKey = team.seasonId || team.circuit || '';
      if (!nightCache.has(nightKey)) nightCache.set(nightKey, await leagueNightFor(team));
      const night = nightCache.get(nightKey);

      const reasons = [];
      if (isTestTeam(team)) reasons.push('test team');
      if (p.pendingAdd) reasons.push('still pending approval');
      if (p.archived) reasons.push('archived from this roster');
      if (!normalizeEmail(p.email)) reasons.push('no email on file');
      const email = normalizeEmail(p.email);
      const sent = email ? history.welcomes.get(email) : null;
      const stamped = p.welcomedAt && new Date(p.welcomedAt).getTime() >= since;
      if (!stamped && !sent) {
        if (!p.welcomedAt) reasons.push('no welcomedAt stamp (a roster save wiped it, or the welcome never sent)' + (history.ok ? ` and Resend shows no welcome to this address in the last ${days} days` : ' — Resend history unavailable: ' + (history.error || 'unknown')));
        else reasons.push(`welcomed ${String(p.welcomedAt).slice(0, 10)}, outside the ${days}-day window`);
      }
      if (p.welcomeCorrectedAt) reasons.push(`already corrected ${String(p.welcomeCorrectedAt).slice(0, 10)}`);
      else if (email && history.corrections.has(email)) reasons.push('Resend shows a correction already went to this address');
      if (!night.dayName) reasons.push('season has no start date, so no league night to correct to');
      else if (night.dayName === 'Monday') reasons.push('season resolves to Monday — the welcome was right');

      out.push({
        teamId: team.id, teamName: team.name || '', seasonId: team.seasonId || null, circuit: team.circuit || null,
        seasonName: seasonName(team.circuit || team.seasonId),
        playerId: p.id, name: p.name || '', email: p.email || '',
        pendingAdd: !!p.pendingAdd, archived: !!p.archived,
        welcomedAt: p.welcomedAt || sent?.sentAt || null, welcomeSource: stamped ? 'stamp' : (sent ? 'resend' : null),
        welcomeCorrectedAt: p.welcomeCorrectedAt || null,
        night, eligible: reasons.length === 0, reasons,
        // Can the admin force this one onto the send? Hard blockers only.
        forceable: !isTestTeam(team) && !p.pendingAdd && !p.archived && !!normalizeEmail(p.email)
          && !p.welcomeCorrectedAt && !!night.dayName && night.dayName !== 'Monday',
      });
    }
  }
  return out;
}

/** Entries the admin forced in by "teamId:playerId" — same hard blockers as above. */
async function forcedRecipients(keys) {
  const want = new Set((keys || []).map(String).filter(Boolean));
  if (!want.size) return [];
  const teams = getStore('teams');
  const out = [];
  for (const k of want) {
    const [teamId, playerId] = k.split(':');
    if (!teamId || !playerId) continue;
    const teamKey = `team/${teamId}.json`;
    const team = await teams.get(teamKey, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!team || isTestTeam(team)) continue;
    const p = (team.roster || []).find(x => x && String(x.id) === playerId);
    if (!p || p.pendingAdd || p.archived || p.welcomeCorrectedAt || !normalizeEmail(p.email)) continue;
    const night = await leagueNightFor(team);
    if (!night.dayName || night.dayName === 'Monday') continue;
    out.push({
      teamId: team.id, teamKey, teamName: team.name || 'your team',
      seasonName: seasonName(team.circuit || team.seasonId),
      playerId: p.id, name: p.name || '', email: normalizeEmail(p.email),
      welcomedAt: p.welcomedAt || null, night, forced: true,
    });
  }
  return out;
}

export default async (req) => {
  const admin = await verifyAdminSession(req);
  if (!admin.valid) return unauthResponse(admin.error);

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const days = windowDays(url.searchParams.get('days'));
    const find = url.searchParams.get('find');
    if (find != null) return json({ days, query: find, matches: await explain(find, days) });
    const found = await findRecipients(days);
    return json({
      days,
      count: found.recipients.length,
      alreadySent: found.alreadySent,
      skippedMonday: found.skippedMonday,
      noNight: found.noNight,
      history: found.history,
      recipients: found.recipients.map(({ teamKey, ...r }) => r),
    });
  }

  if (req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch { /* empty body is fine */ }
    const days = windowDays(body.days);
    const { recipients: auto } = await findRecipients(days);
    const forced = await forcedRecipients(body.include);
    const seen = new Set(auto.map(r => `${r.teamId}:${r.playerId}`));
    const recipients = auto.concat(forced.filter(r => !seen.has(`${r.teamId}:${r.playerId}`)));
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
