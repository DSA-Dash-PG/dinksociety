// netlify/functions/captain-score.js
//
// Single-entry scoring with final dual-approval. One shared scoresheet:
// either captain enters each game's home + away score once. The match
// finalizes only when:
//   1. All 12 games have a complete, valid score (to 11, win by 2)
//   2. Both captains have tapped "Submit final" since the last edit
//
// GET   ?match=<id>                          → state + computed view
// PUT   ?match=<id>                          → save game scores (either captain)
//                                                body: { games: { r1g1: { home: 11, away: 4 }, ... } }
// POST  ?match=<id>&action=submit            → mark this captain's "I approve" flag
// POST  ?match=<id>&action=withdraw          → revoke my approval (only allowed pre-finalize)
//
// Storage shape:
//   game = { home: <homeScore>|null, away: <awayScore>|null, by, at }
//
// Computed status per game (server-derived, never persisted):
//   'empty'      both scores null
//   'partial'    one score entered
//   'confirmed'  both entered AND a valid finished game
//   'mismatch'   both entered but NOT a valid finished game — blocks save + submit

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';
import { circuitCode } from './lib/circuit.js';
import {
  SLOT_KEYS, newScoreRecord, toScore, decorate, prettySlot,
} from './lib/score-helpers.js';

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const scheduleStore = getStore('schedule');
  const scoresStore = getStore('scores');
  const lineupStore = getStore('lineups');
  const seasonStore = getStore('seasons');
  const seasonData = ctx.team.seasonId
    ? await seasonStore.get(ctx.team.seasonId, { type: 'json' }).catch(() => null)
    : null;
  const WEEKS = seasonData?.weeks || 8;

  const match = await findMatch(scheduleStore, matchId, ctx.team, WEEKS);
  if (!match) return json({ error: 'Match not found or not yours' }, 404);

  const myRole = match.teamA.id === ctx.team.id ? 'home' : 'away';
  const scoreKey = `score/${matchId}.json`;

  const [lineupHome, lineupAway] = await Promise.all([
    lineupStore.get(`lineup/${matchId}/${match.teamA.id}.json`, { type: 'json' }).catch(() => null),
    lineupStore.get(`lineup/${matchId}/${match.teamB.id}.json`, { type: 'json' }).catch(() => null),
  ]);
  const revealed = !!lineupHome?.lockedAt && !!lineupAway?.lockedAt;

  // ===== GET =====
  if (req.method === 'GET') {
    if (!revealed) {
      return json({
        matchId, myRole, revealed: false,
        message: 'Both lineups must be locked before scoring.',
      });
    }
    const score = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);

    return json({
      matchId, myRole, revealed: true,
      match: publicMatchInfo(match),
      homeLineup: sanitizeLineup(lineupHome),
      awayLineup: sanitizeLineup(lineupAway),
      score: decorate(score, match.championship),
    });
  }

  if (!revealed) return json({ error: 'Both lineups must be locked before scoring' }, 409);

  // ===== PUT =====
  if (req.method === 'PUT') {
    const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);

    if (existing.finalizedAt) {
      return json({ error: 'Match is final. Contact admin to reopen.' }, 409);
    }

    const body = await req.json();
    const incoming = body.games || {};
    const now = new Date().toISOString();
    let changed = false;

    // Single shared scoresheet: either captain may enter/edit any game's
    // home + away scores. Incoming per slot: { home?: N|null, away?: M|null }.
    for (const slot of SLOT_KEYS) {
      if (!(slot in incoming)) continue;
      const g = incoming[slot] || {};
      if (!existing.games[slot]) existing.games[slot] = { home: null, away: null };
      const cur = existing.games[slot];
      let slotChanged = false;

      for (const side of ['home', 'away']) {
        if (!(side in g)) continue;
        const raw = g[side];
        const newVal = (raw === '' || raw === null || raw === undefined) ? null : toScore(raw);
        if (newVal === 'INVALID') {
          return json({ error: `${prettySlot(slot)}: scores must be integers 0-30` }, 400);
        }
        if (cur[side] === newVal) continue; // no change
        cur[side] = newVal;
        slotChanged = true;
      }

      if (slotChanged) {
        cur.by = ctx.user.email;
        cur.at = now;
        changed = true;
      }
    }

    // Reject save if any fully-entered game pair is invalid (mismatch).
    // Partial entries (one side only) are allowed mid-entry.
    const winBy = match.championship ? 2 : 1;
    const mismatchedSlots = SLOT_KEYS.filter(slot => {
      const g = existing.games[slot];
      if (!g) return false;
      const hHas = Number.isInteger(g.home);
      const aHas = Number.isInteger(g.away);
      if (!hHas || !aHas) return false; // partial — ok
      return !isValidGame(g.home, g.away, winBy);
    });

    if (mismatchedSlots.length > 0) {
      const labels = mismatchedSlots.map(prettySlot).join(', ');
      const rule = match.championship ? 'first to 11, win by 2' : 'first to 11';
      return json({
        error: `${mismatchedSlots.length} game(s) have invalid scores (${rule}): ${labels}. Fix before saving.`,
        mismatchedSlots,
      }, 400);
    }

    // Any score change wipes both submit flags — both captains must re-approve.
    if (changed && (existing.homeSubmittedAt || existing.awaySubmittedAt)) {
      existing.homeSubmittedAt = null;
      existing.homeSubmittedBy = null;
      existing.awaySubmittedAt = null;
      existing.awaySubmittedBy = null;
    }

    existing.updatedAt = now;
    existing.updatedBy = ctx.user.email;

    await scoresStore.setJSON(scoreKey, existing);
    return json({ ok: true, score: decorate(existing, match.championship) });
  }

  // ===== POST submit / withdraw =====
  if (req.method === 'POST') {
    const action = url.searchParams.get('action');
    if (!['submit', 'withdraw'].includes(action)) {
      return json({ error: 'action must be submit or withdraw' }, 400);
    }

    const existing = await scoresStore.get(scoreKey, { type: 'json' }).catch(() => null)
      || newScoreRecord(match);

    if (action === 'submit') {
      if (existing.finalizedAt) {
        return json({ error: 'Already finalized' }, 409);
      }

      const decorated = decorate(existing, match.championship);

      // Check for mismatched slots first (invalid score pairs)
      const mismatchedSlots = decorated.computed.gameStatuses
        .filter(g => g.status === 'mismatch')
        .map(g => g.slot);
      if (mismatchedSlots.length > 0) {
        const rule = match.championship ? 'first to 11, win by 2' : 'first to 11';
        const labels = mismatchedSlots.map(prettySlot).slice(0, 3).join(', ');
        const more = mismatchedSlots.length > 3 ? ` and ${mismatchedSlots.length - 3} more` : '';
        return json({
          error: `Cannot submit — ${mismatchedSlots.length} game(s) have invalid scores (${rule}): ${labels}${more}. Both home and away scores must form a valid finished game.`,
          mismatchedSlots,
        }, 400);
      }

      // All games must be CONFIRMED (both sides entered + valid)
      const unconfirmed = decorated.computed.gameStatuses.filter(g => g.status !== 'confirmed');
      if (unconfirmed.length > 0) {
        const rule = match.championship ? 'first to 11, win by 2' : 'first to 11';
        const labels = unconfirmed.map(g => prettySlot(g.slot)).slice(0, 3).join(', ');
        const more = unconfirmed.length > 3 ? ` and ${unconfirmed.length - 3} more` : '';
        return json({
          error: `Cannot submit yet — ${unconfirmed.length} game(s) need a complete, valid score (${rule}): ${labels}${more}.`,
        }, 400);
      }

      const now = new Date().toISOString();
      if (myRole === 'home') {
        existing.homeSubmittedAt = now;
        existing.homeSubmittedBy = ctx.user.email;
      } else {
        existing.awaySubmittedAt = now;
        existing.awaySubmittedBy = ctx.user.email;
      }

      // Both submitted → finalize and write to schedule
      if (existing.homeSubmittedAt && existing.awaySubmittedAt) {
        existing.finalizedAt = now;
        try {
          await writeFinalScoreToSchedule(scheduleStore, match, existing);
        } catch (err) {
          console.error('writeFinalScoreToSchedule failed for match', matchId, ':', err);
          // Don't block finalize — score record is already marked final
        }
        // Rebuild standings + player-stats aggregates for this Circuit.
        // Wrapped so a standings error doesn't block the finalize itself.
        rebuildStandings(match.circuit).catch(err =>
          console.error('rebuildStandings failed post-finalize for match', matchId, 'circuit', match.circuit, ':', err)
        );
      }
    } else {
      // Withdraw
      if (existing.finalizedAt) {
        return json({ error: 'Match is finalized. Contact admin to reopen.' }, 409);
      }
      if (myRole === 'home') {
        existing.homeSubmittedAt = null;
        existing.homeSubmittedBy = null;
      } else {
        existing.awaySubmittedAt = null;
        existing.awaySubmittedBy = null;
      }
    }

    await scoresStore.setJSON(scoreKey, existing);
    return json({ ok: true, score: decorate(existing, match.championship) });
  }

  return new Response('Method not allowed', { status: 405 });
};

// ===== Helpers =====

async function findMatch(scheduleStore, matchId, team, weeks = 8) {
  const circuit = circuitCode(team.circuit);
  for (let week = 1; week <= weeks; week++) {
    const key = `schedule/${circuit}/${team.division}/week-${week}.json`;
    const data = await scheduleStore.get(key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m && (m.teamA?.id === team.id || m.teamB?.id === team.id)) {
      return { ...m, week, circuit, division: team.division, scheduleKey: key };
    }
  }
  return null;
}

function sanitizeLineup(lineup) {
  if (!lineup) return null;
  return { teamId: lineup.teamId, teamName: lineup.teamName, games: lineup.games };
}

function publicMatchInfo(match) {
  return {
    id: match.id, week: match.week, court: match.court,
    courtA: match.courtA ?? null,
    courtB: match.courtB ?? null,
    courtSet: match.courtSet ?? null,
    championship: !!match.championship,
    venue: match.venue || null,
    scheduledAt: match.scheduledAt || null,
    circuit: match.circuit, division: match.division,
    home: { id: match.teamA.id, name: match.teamA.name },
    away: { id: match.teamB.id, name: match.teamB.name },
  };
}

function isValidGame(h, a, winBy = 1) {
  if (!Number.isInteger(h) || !Number.isInteger(a)) return false;
  if (h === a) return false;
  const hi = Math.max(h, a), lo = Math.min(h, a);
  if (winBy === 2) {
    if (hi < 11) return false;
    if (hi - lo < 2) return false;
    return hi === 11 ? lo <= 9 : (hi - lo) === 2;
  }
  if (hi !== 11) return false;
  return lo >= 0 && lo <= 10;
}

async function writeFinalScoreToSchedule(scheduleStore, match, score) {
  const data = await scheduleStore.get(match.scheduleKey, { type: 'json' });
  if (!data?.matches) {
    throw new Error(`scheduleKey ${match.scheduleKey} returned no matches array`);
  }
  const m = data.matches.find(x => x.id === match.id);
  if (!m) {
    throw new Error(`match ${match.id} not found in scheduleKey ${match.scheduleKey}`);
  }

  const decorated = decorate(score, match.championship);
  m.scoreA = decorated.computed.matchPoints.home;
  m.scoreB = decorated.computed.matchPoints.away;
  m.finalizedAt = score.finalizedAt;
  m.round1 = decorated.computed.round1;
  m.round2 = decorated.computed.round2;

  data.updatedAt = new Date().toISOString();
  await scheduleStore.setJSON(match.scheduleKey, data);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-score' };
