// netlify/functions/admin-suspend-match.js
//
// Rain-out / carry-over tooling. A match that was stopped part way through is
// SUSPENDED: every game confirmed so far is frozen (score final, counts in the
// standings right away), both lineups are reopened so the captains can change
// who plays the remaining games, and the remainder is played at `resumeAt` —
// typically the next game night, before the regular matches. The lock/reveal
// clock for the remaining games runs off resumeAt (lib/live-results.js).
//
// POST ?action=suspend&circuit=II
//   body: { matchId }                       one match
//     or  { week, division }                every unfinished match of that week
//   plus  { resumeAt (ISO, required), note?, notify? (default true),
//           freeze? (default true — freeze the confirmed games; false = none) }
// POST ?action=update&circuit=II   body: { matchId, resumeAt?, note?, notify? }
// POST ?action=cancel&circuit=II   body: { matchId }
//   Removes the suspension. Lineups are left as they are (captains re-lock);
//   scores are untouched.
//
// Admin-only. Standings are rebuilt after every change so the frozen games
// show up (unofficially) at once.

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';
import { normalizeScore, decorate, SLOT_KEYS } from './lib/score-helpers.js';
import { logActivity } from './lib/activity-log.js';
import { sendEmail, renderMatchSuspended } from './lib/email.js';
import { formatOffset, DEFAULT_LOCK_OFFSET_MIN } from './lib/lineup-helpers.js';
import { publicSuspension } from './lib/live-results.js';

const TZ = 'America/Los_Angeles';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'suspend';
  const circuit = url.searchParams.get('circuit') || 'I';
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  // Strong reads: this writes the same week file captain-score / admin-matches
  // write, and must never build on a stale copy.
  const scheduleStore = getStore({ name: 'schedule', consistency: 'strong' });
  const scoresStore = getStore({ name: 'scores', consistency: 'strong' });
  const lineupStore = getStore({ name: 'lineups', consistency: 'strong' });
  const teamsStore = getStore('teams');
  const seasonStore = getStore('seasons');

  try {
    // ── Locate the target match(es) ──
    let targets = [];
    if (body.matchId) {
      const hit = await findMatch(scheduleStore, circuit, body.matchId);
      if (!hit) return json({ error: 'Match not found' }, 404);
      targets = [hit];
    } else if (body.week && body.division) {
      const key = `schedule/${circuit}/${body.division}/week-${parseInt(body.week, 10)}.json`;
      const data = await scheduleStore.get(key, { type: 'json' }).catch(() => null);
      if (!data?.matches) return json({ error: 'No schedule for that week' }, 404);
      targets = data.matches
        .filter(m => m.teamA?.id && m.teamB?.id)
        .map(m => ({ key, data, m }));
    } else {
      return json({ error: 'matchId, or week + division, required' }, 400);
    }

    const now = new Date().toISOString();
    const results = [];

    if (action === 'suspend' || action === 'update') {
      const resumeAt = body.resumeAt ? new Date(body.resumeAt) : null;
      if (action === 'suspend' && (!resumeAt || isNaN(resumeAt))) {
        return json({ error: 'resumeAt (a valid date/time) is required' }, 400);
      }
      if (resumeAt && !isNaN(resumeAt) && resumeAt.getTime() < Date.now() - 60000) {
        return json({ error: 'resumeAt must be in the future' }, 400);
      }
      const freeze = body.freeze !== false;
      const notify = body.notify !== false;

      for (const t of targets) {
        const { m } = t;
        if (m.finalizedAt) { results.push({ matchId: m.id, skipped: 'final' }); continue; }
        if (action === 'update' && !m.suspended) { results.push({ matchId: m.id, skipped: 'not suspended' }); continue; }

        const score = await scoresStore.get(`score/${m.id}.json`, { type: 'json' }).catch(() => null);
        const dec = score ? decorate(normalizeScore(score, !!m.championship), !!m.championship) : null;
        const confirmed = dec
          ? dec.computed.gameStatuses.filter(g => g.status === 'confirmed').map(g => g.slot)
          : [];

        if (action === 'suspend') {
          // A match that hasn't started (nothing confirmed) can still be
          // suspended — it just moves whole to the resume time with no
          // frozen games, which is the same as rescheduling it.
          const lockedSlots = freeze ? confirmed : [];
          m.suspended = {
            at: now,
            by: admin.email,
            resumeAt: resumeAt.toISOString(),
            originalScheduledAt: m.suspended?.originalScheduledAt || m.scheduledAt || null,
            lockedSlots,
            snapshot: dec ? snapshotOf(dec, score, lockedSlots) : null,
            note: String(body.note || '').trim().slice(0, 500) || null,
          };
        } else {
          if (resumeAt && !isNaN(resumeAt)) m.suspended.resumeAt = resumeAt.toISOString();
          if ('note' in body) m.suspended.note = String(body.note || '').trim().slice(0, 500) || null;
          m.suspended.updatedAt = now;
          m.suspended.updatedBy = admin.email;
        }

        // Reopen both lineups for the remaining games. The lineups themselves
        // (who played the frozen games) are kept — captain-lineup.js refuses
        // changes to frozen slots. Scores are NOT touched.
        let reopened = 0;
        if (action === 'suspend') {
          for (const teamId of [m.teamA.id, m.teamB.id]) {
            const k = `lineup/${m.id}/${teamId}.json`;
            const lu = await lineupStore.get(k, { type: 'json' }).catch(() => null);
            if (!lu) continue;
            if (lu.lockedAt) {
              lu.lockedAt = null;
              lu.lockedBy = null;
              lu.reopenedAt = now;
              lu.reopenedBy = admin.email;
              lu.reopenedFor = 'suspension';
              lu.updatedAt = now;
              await lineupStore.setJSON(k, lu);
              reopened++;
            }
          }
        }

        t.data.updatedAt = now;
        t.data.updatedBy = admin.email;
        await scheduleStore.setJSON(t.key, t.data);

        await logActivity({
          type: action === 'suspend' ? 'match.suspended' : 'match.suspension-updated',
          actor: { email: admin.email, role: 'admin' },
          matchId: m.id, week: t.data.week, circuit,
          details: action === 'suspend'
            ? `Week ${t.data.week} ${m.teamA.name} vs ${m.teamB.name} suspended — ${m.suspended.lockedSlots.length} game(s) frozen, resumes ${fmtWhen(m.suspended.resumeAt)}`
            : `Week ${t.data.week} ${m.teamA.name} vs ${m.teamB.name} suspension updated — resumes ${fmtWhen(m.suspended.resumeAt)}`,
        });

        let emailed = 0;
        if (notify) {
          emailed = await notifyCaptains({ m, week: t.data.week, teamsStore, seasonStore, circuit }).catch(err => {
            console.error('suspend notify failed', err);
            return 0;
          });
        }

        results.push({
          matchId: m.id,
          teams: `${m.teamA.name} vs ${m.teamB.name}`,
          frozen: m.suspended.lockedSlots.length,
          remaining: SLOT_KEYS.length - m.suspended.lockedSlots.length,
          lineupsReopened: reopened,
          emailed,
          suspended: publicSuspension(m),
        });
      }
    } else if (action === 'cancel') {
      for (const t of targets) {
        const { m } = t;
        if (!m.suspended) { results.push({ matchId: m.id, skipped: 'not suspended' }); continue; }
        const was = m.suspended;
        delete m.suspended;
        t.data.updatedAt = now;
        t.data.updatedBy = admin.email;
        await scheduleStore.setJSON(t.key, t.data);
        await logActivity({
          type: 'match.suspension-cancelled',
          actor: { email: admin.email, role: 'admin' },
          matchId: m.id, week: t.data.week, circuit,
          details: `Week ${t.data.week} ${m.teamA.name} vs ${m.teamB.name} suspension removed (was resuming ${fmtWhen(was.resumeAt)})`,
        });
        results.push({ matchId: m.id, teams: `${m.teamA.name} vs ${m.teamB.name}`, cancelled: true });
      }
    } else {
      return json({ error: 'action must be suspend, update or cancel' }, 400);
    }

    // Frozen games count in the (unofficial) standings straight away.
    try { await rebuildStandings(circuit); }
    catch (err) { console.error('rebuildStandings after suspend failed:', err); }

    return json({ ok: true, action, results });
  } catch (err) {
    console.error('admin-suspend-match error:', err);
    return json({ error: 'Suspend failed', detail: err.message }, 500);
  }
};

// ── helpers ──────────────────────────────────────────────────────────

async function findMatch(scheduleStore, circuit, matchId) {
  const { blobs } = await scheduleStore.list({ prefix: `schedule/${circuit}/` });
  for (const b of blobs) {
    const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m) return { key: b.key, data, m };
  }
  return null;
}

// Confirmed-game totals at the moment of the stoppage, for the schedule page
// ("R1 final 4–2") — the live standings compute their own numbers.
function snapshotOf(dec, score, lockedSlots) {
  const locked = new Set(lockedSlots);
  let gamesHome = 0, gamesAway = 0, pointsHome = 0, pointsAway = 0;
  for (const slot of locked) {
    const g = score.games[slot];
    if (!Number.isInteger(g?.home) || !Number.isInteger(g?.away)) continue;
    pointsHome += g.home; pointsAway += g.away;
    if (g.home > g.away) gamesHome++; else if (g.away > g.home) gamesAway++;
  }
  const r = (x) => ({ homeGames: x.homeGames, awayGames: x.awayGames, homePoints: x.homePoints, awayPoints: x.awayPoints, scoredGames: x.scoredGames });
  return {
    gamesHome, gamesAway, pointsHome, pointsAway,
    round1: r(dec.computed.round1),
    round2: r(dec.computed.round2),
    matchPoints: { ...dec.computed.matchPoints },
  };
}

function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });
}

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.app';
}

const norm = (e) => (e || '').trim().toLowerCase();

// Email both teams' captains + co-captains. Each side gets its own mail (its
// own team name first, its own portal) — never the other side's lineup.
async function notifyCaptains({ m, week, teamsStore, seasonStore, circuit }) {
  const [teamA, teamB] = await Promise.all([
    teamsStore.get(`team/${m.teamA.id}.json`, { type: 'json' }).catch(() => null),
    teamsStore.get(`team/${m.teamB.id}.json`, { type: 'json' }).catch(() => null),
  ]);
  if (!teamA || !teamB) return 0;
  const seasonData = teamA.seasonId
    ? await seasonStore.get(teamA.seasonId, { type: 'json' }).catch(() => null) : null;
  const lockOffset = Number(seasonData?.lineupLockOffsetMin) || DEFAULT_LOCK_OFFSET_MIN;

  const s = m.suspended;
  const resumeLine = fmtWhen(s.resumeAt);
  const lockLine = `Lineups hard-lock ${formatOffset(lockOffset)} before play resumes.`;
  const snap = s.snapshot;
  const resultLine = snap
    ? `So far: ${m.teamA.name} ${snap.gamesHome}, ${m.teamB.name} ${snap.gamesAway} in games (${snap.matchPoints.home}–${snap.matchPoints.away} match points).`
    : '';

  const jobs = [];
  for (const [team, opp] of [[teamA, teamB], [teamB, teamA]]) {
    const to = new Set();
    if (norm(team.captainEmail)) to.add(norm(team.captainEmail));
    for (const p of (team.roster || [])) if ((p.isCaptain || p.isCoCaptain) && norm(p.email) && !p.archived) to.add(norm(p.email));
    if (!to.size) continue;
    const html = renderMatchSuspended({
      teamName: team.name, teamEmoji: team.emoji || '',
      opponentName: opp.name, oppEmoji: opp.emoji || '',
      week, resumeLine, lockLine,
      lockedCount: s.lockedSlots.length,
      remaining: SLOT_KEYS.length - s.lockedSlots.length,
      resultLine, note: s.note || '',
      portalUrl: `${siteUrl()}/captain.html`,
    });
    const subject = `Week ${week} resumes ${resumeLine} — set your lineup for the remaining games`;
    for (const addr of to) jobs.push(sendEmail({ to: addr, subject, html }));
  }
  const res = await Promise.allSettled(jobs);
  return res.filter(r => r.status === 'fulfilled').length;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-suspend-match' };
