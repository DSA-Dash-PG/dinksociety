// netlify/functions/admin-scores.js
// Admin-only score entry and override. Uses the shared dual-entry score
// model (lib/score-helpers.js): an admin-entered score is written as BOTH
// teams' entries (admin acts as both sides), so it reads as confirmed.
//
// GET  ?match=<id>                → get current score state for a match
// PUT  ?match=<id>               → enter/update scores (admin acts as both sides)
//      body: { games: { r1g1: { home: 11, away: 7 }, ... } }
// POST ?match=<id>&action=finalize  → force-finalize a match
// POST ?match=<id>&action=reopen    → un-finalize a match so scores can be edited
// POST ?match=<id>&action=restart   → wipe ALL scores + sign-offs; match becomes a
//                                     fresh scoresheet both captains can re-enter

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';
import {
  SLOT_KEYS, newScoreRecord, toScore, decorate, normalizeScore, prettySlot,
} from './lib/score-helpers.js';

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const scheduleStore = getStore('schedule');
  // Strong consistency: admin score edits can land WHILE captains are entering
  // the same match. Default (eventual) reads would let an admin write build on
  // a stale copy and clobber a live captain entry; strong reads + the
  // etag-guarded withScore() helper below make admin and captain writes safe
  // against each other (same optimistic-concurrency model as captain-score.js).
  const scoresStore = getStore({ name: 'scores', consistency: 'strong' });

  // Find the match across all schedule files
  const match = await findMatch(scheduleStore, matchId);
  if (!match) return json({ error: 'Match not found' }, 404);

  const scoreKey = `score/${matchId}.json`;

  // ===== GET =====
  if (req.method === 'GET') {
    const score = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);
    // Include lineups so the admin scoresheet can show who played each game
    const lineupStore = getStore('lineups');
    const [lineupHome, lineupAway] = await Promise.all([
      lineupStore.get(`lineup/${matchId}/${match.teamA.id}.json`, { type: 'json' }).catch(() => null),
      lineupStore.get(`lineup/${matchId}/${match.teamB.id}.json`, { type: 'json' }).catch(() => null),
    ]);
    return json({
      match: matchInfo(match),
      score: decorate(score, !!match.championship),
      homeLineup: slimLineup(lineupHome),
      awayLineup: slimLineup(lineupAway),
    });
  }

  // ===== PUT — enter/update scores (acts as both sides) =====
  if (req.method === 'PUT') {
    const body = await req.json();
    const incoming = body.games || {};

    const r = await withScore(scoresStore, scoreKey, match, (existing) => {
      const now = new Date().toISOString();
      for (const slot of SLOT_KEYS) {
        if (!(slot in incoming)) continue;
        const g = incoming[slot] || {};

        const homeVal = toScore(g.home);
        const awayVal = toScore(g.away);
        if (homeVal === 'INVALID' || awayVal === 'INVALID') {
          return { error: `${prettySlot(slot)}: scores must be integers 0-30`, status: 400 };
        }

        // Admin override: write the same entry as BOTH teams' versions, or
        // clear the slot entirely when both values are blank.
        const cur = existing.games[slot];
        if (homeVal === null && awayVal === null) {
          cur.homeEntry = null;
          cur.awayEntry = null;
        } else {
          const entry = { home: homeVal, away: awayVal, by: admin.email, at: now };
          cur.homeEntry = { ...entry };
          cur.awayEntry = { ...entry };
        }
      }

      normalizeScore(existing, !!match.championship);
      existing.updatedAt = now;
      existing.updatedBy = admin.email;
      existing.adminEdited = true;
    });

    if (r.abort) return json(r.abort, r.abort.status || 400);
    if (r.conflict) return json({ error: 'A captain was saving at the same moment — please try again.' }, 503);
    return json({ ok: true, score: decorate(r.record, !!match.championship) });
  }

  // ===== POST — finalize or reopen =====
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');

    if (action === 'finalize') {
      const r = await withScore(scoresStore, scoreKey, match, (existing, existed) => {
        if (!existed) return { error: 'No scores entered yet', status: 400 };

        const decorated = decorate(existing, !!match.championship);
        if (!decorated.computed.allConfirmed) {
          return {
            error: `Cannot finalize — ${12 - decorated.computed.counts.confirmed} games still need scores.`,
            unentered: decorated.computed.unentered,
            status: 400,
          };
        }

        const now = new Date().toISOString();
        existing.homeSubmittedAt = existing.homeSubmittedAt || now;
        existing.homeSubmittedBy = existing.homeSubmittedBy || admin.email;
        existing.homeSignedName = existing.homeSignedName || 'League admin';
        existing.awaySubmittedAt = existing.awaySubmittedAt || now;
        existing.awaySubmittedBy = existing.awaySubmittedBy || admin.email;
        existing.awaySignedName = existing.awaySignedName || 'League admin';
        existing.finalizedAt = now;
        existing.finalizedBy = admin.email;
      });

      if (r.abort) return json(r.abort, r.abort.status || 400);
      if (r.conflict) return json({ error: 'A captain was saving at the same moment — please try again.' }, 503);

      // Write final scores to schedule
      await writeFinalScoreToSchedule(scheduleStore, match, r.record);

      // Rebuild standings — awaited so the serverless freeze can't kill it.
      try {
        await rebuildStandings(match.circuit);
      } catch (err) {
        console.error('rebuildStandings failed:', err);
      }

      return json({ ok: true, finalized: true, score: decorate(r.record, !!match.championship) });
    }

    if (action === 'reopen') {
      const r = await withScore(scoresStore, scoreKey, match, (existing, existed) => {
        if (!existed) return { error: 'No scores to reopen', status: 400 };

        existing.finalizedAt = null;
        existing.finalizedBy = null;
        existing.homeSubmittedAt = null;
        existing.homeSubmittedBy = null;
        existing.homeSignedName = null;
        existing.awaySubmittedAt = null;
        existing.awaySubmittedBy = null;
        existing.awaySignedName = null;
        existing.reopenedAt = new Date().toISOString();
        existing.reopenedBy = admin.email;
      });

      if (r.abort) return json(r.abort, r.abort.status || 400);
      if (r.conflict) return json({ error: 'A captain was saving at the same moment — please try again.' }, 503);

      // Clear final scores from schedule
      await clearFinalScoreFromSchedule(scheduleStore, match);

      // Rebuild standings — awaited so the serverless freeze can't kill it.
      try {
        await rebuildStandings(match.circuit);
      } catch (err) {
        console.error('rebuildStandings failed after reopen:', err);
      }

      return json({ ok: true, reopened: true, score: decorate(r.record, !!match.championship) });
    }

    if (action === 'restart') {
      // Wipe everything: both captains' entries, sign-offs, finalization.
      // Lineups stay locked — captains can immediately re-enter scores or
      // the teams can replay the games. Standings are rebuilt in case the
      // match had already been finalized. Guarded so a re-wipe still wins
      // cleanly if a captain write lands mid-restart.
      const r = await withScore(scoresStore, scoreKey, match, (_existing) => {
        const fresh = newScoreRecord(match);
        fresh.restartedAt = new Date().toISOString();
        fresh.restartedBy = admin.email;
        return { replace: fresh };
      });

      if (r.conflict) return json({ error: 'A captain was saving at the same moment — please try again.' }, 503);

      // Clear final scores from schedule (no-op if never finalized)
      await clearFinalScoreFromSchedule(scheduleStore, match);

      // Rebuild standings — awaited so the serverless freeze can't kill it.
      try {
        await rebuildStandings(match.circuit);
      } catch (err) {
        console.error('rebuildStandings failed after restart:', err);
      }

      return json({ ok: true, restarted: true, score: decorate(r.record, !!match.championship) });
    }

    return json({ error: 'action must be finalize, reopen, or restart' }, 400);
  }

  return new Response('Method not allowed', { status: 405 });
};

// ===== Helpers =====

// Optimistic, etag-guarded read-modify-write on the score blob — the same
// concurrency model captain-score.js uses, so an admin edit can't silently
// clobber a captain entry (or vice-versa). `mutate(record, existed)` either:
//   - mutates `record` in place and returns nothing  → that record is written
//   - returns { replace: newRecord }                 → newRecord is written
//   - returns { error, status, ... }                 → abort without writing
// Returns { record } on success, { abort } on a mutate-signalled error, or
// { conflict: true } if 5 attempts all lost the race.
async function withScore(scoresStore, scoreKey, match, mutate) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const got = await scoresStore.getWithMetadata(scoreKey, { type: 'json' }).catch(() => null);
    const record = got?.data || newScoreRecord(match);
    const etag = got?.etag || null;
    normalizeScore(record, !!match.championship);

    const out = mutate(record, !!got);
    if (out && out.error) return { abort: out };
    const toWrite = out && out.replace ? out.replace : record;

    const res = etag
      ? await scoresStore.setJSON(scoreKey, toWrite, { onlyIfMatch: etag })
      : await scoresStore.setJSON(scoreKey, toWrite, { onlyIfNew: true });
    const saved = !res || res.modified !== false;
    if (saved) return { record: toWrite };
  }
  return { conflict: true };
}

async function findMatch(scheduleStore, matchId) {
  const { blobs } = await scheduleStore.list({ prefix: 'schedule/' });
  for (const b of blobs) {
    const data = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m) {
      return {
        ...m,
        week: data.week,
        circuit: data.circuit,
        division: data.division,
        scheduleKey: b.key,
      };
    }
  }
  return null;
}

function slimLineup(lineup) {
  if (!lineup) return null;
  return { teamId: lineup.teamId, teamName: lineup.teamName, lockedAt: lineup.lockedAt || null, games: lineup.games || {} };
}

function matchInfo(match) {
  return {
    id: match.id,
    week: match.week,
    circuit: match.circuit,
    division: match.division,
    court: match.court || null,
    championship: !!match.championship,
    scheduledAt: match.scheduledAt || null,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
    finalizedAt: match.finalizedAt || null,
  };
}

async function writeFinalScoreToSchedule(scheduleStore, match, score) {
  const data = await scheduleStore.get(match.scheduleKey, { type: 'json' }).catch(() => null);
  if (!data?.matches) return;
  const m = data.matches.find(x => x.id === match.id);
  if (!m) return;
  const decorated = decorate(score, !!match.championship);
  m.scoreA = decorated.computed.matchPoints.home;
  m.scoreB = decorated.computed.matchPoints.away;
  m.finalizedAt = score.finalizedAt;
  m.round1 = decorated.computed.round1;
  m.round2 = decorated.computed.round2;
  data.updatedAt = new Date().toISOString();
  await scheduleStore.setJSON(match.scheduleKey, data);
}

async function clearFinalScoreFromSchedule(scheduleStore, match) {
  const data = await scheduleStore.get(match.scheduleKey, { type: 'json' }).catch(() => null);
  if (!data?.matches) return;
  const m = data.matches.find(x => x.id === match.id);
  if (!m) return;
  m.scoreA = null;
  m.scoreB = null;
  m.finalizedAt = null;
  m.round1 = null;
  m.round2 = null;
  data.updatedAt = new Date().toISOString();
  await scheduleStore.setJSON(match.scheduleKey, data);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-scores' };
