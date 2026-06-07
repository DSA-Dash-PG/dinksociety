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
  const scoresStore = getStore('scores');

  // Find the match across all schedule files
  const match = await findMatch(scheduleStore, matchId);
  if (!match) return json({ error: 'Match not found' }, 404);

  const scoreKey = `score/${matchId}.json`;

  // ===== GET =====
  if (req.method === 'GET') {
    const score = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);
    return json({ match: matchInfo(match), score: decorate(score, !!match.championship) });
  }

  // ===== PUT — enter/update scores (acts as both sides) =====
  if (req.method === 'PUT') {
    const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);
    normalizeScore(existing, !!match.championship);

    const body = await req.json();
    const incoming = body.games || {};
    const now = new Date().toISOString();

    for (const slot of SLOT_KEYS) {
      if (!(slot in incoming)) continue;
      const g = incoming[slot] || {};

      const homeVal = toScore(g.home);
      const awayVal = toScore(g.away);
      if (homeVal === 'INVALID' || awayVal === 'INVALID') {
        return json({ error: `${prettySlot(slot)}: scores must be integers 0-30` }, 400);
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

    await scoresStore.setJSON(scoreKey, existing);
    return json({ ok: true, score: decorate(existing, !!match.championship) });
  }

  // ===== POST — finalize or reopen =====
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');

    if (action === 'finalize') {
      const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null);
      if (!existing) return json({ error: 'No scores entered yet' }, 400);

      const decorated = decorate(existing, !!match.championship);
      if (!decorated.computed.allConfirmed) {
        return json({
          error: `Cannot finalize — ${12 - decorated.computed.counts.confirmed} games still need scores.`,
          unentered: decorated.computed.unentered,
        }, 400);
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

      await scoresStore.setJSON(scoreKey, existing);

      // Write final scores to schedule
      await writeFinalScoreToSchedule(scheduleStore, match, existing);

      // Rebuild standings — awaited so the serverless freeze can't kill it.
      try {
        await rebuildStandings(match.circuit);
      } catch (err) {
        console.error('rebuildStandings failed:', err);
      }

      return json({ ok: true, finalized: true, score: decorate(existing, !!match.championship) });
    }

    if (action === 'reopen') {
      const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null);
      if (!existing) return json({ error: 'No scores to reopen' }, 400);

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

      await scoresStore.setJSON(scoreKey, existing);

      // Clear final scores from schedule
      await clearFinalScoreFromSchedule(scheduleStore, match);

      // Rebuild standings — awaited so the serverless freeze can't kill it.
      try {
        await rebuildStandings(match.circuit);
      } catch (err) {
        console.error('rebuildStandings failed after reopen:', err);
      }

      return json({ ok: true, reopened: true, score: decorate(existing, !!match.championship) });
    }

    return json({ error: 'action must be finalize or reopen' }, 400);
  }

  return new Response('Method not allowed', { status: 405 });
};

// ===== Helpers =====

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
