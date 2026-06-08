// netlify/functions/captain-lineup.js
// GET   ?match=<id>                → captain's own lineup + status (opponent hidden until both locked)
// PUT   ?match=<id>                → save/update draft OR lock the lineup
//                                     body: { games: {...}, action: 'save' | 'lock' }
//
// Enforces slot gender rules strictly:
//   Round 1 & 2 each have 6 games in this order:
//     g1 = Women's Doubles  (both players F)
//     g2 = Men's Doubles    (both players M)
//     g3-g6 = Mixed Doubles (one M + one F — stored woman-first: p1 is always the woman)
// Also enforces a nightly cap: no player may appear in more than MAX_GAMES_PER_NIGHT games.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { orderMixedWomanFirst, checkGameCap } from './lib/lineup-rules.js';
import { circuitCode } from './lib/circuit.js';
import {
  SLOT_RULES, SLOT_KEYS,
  checkDuplicateCombos, checkBackToBackCombos, checkSimultaneousPairs, checkSlotGender, checkRosterDepth,
  hardLockTime, revealTime, isRevealTime, formatOffset, prettySlot, sanitizeRevealedLineup,
  DEFAULT_LOCK_OFFSET_MIN, DEFAULT_REVEAL_OFFSET_MIN,
} from './lib/lineup-helpers.js';
import { logActivity } from './lib/activity-log.js';

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const scheduleStore = getStore('schedule');
  const lineupStore = getStore('lineups');
  const seasonStore = getStore('seasons');
  const seasonData = ctx.team.seasonId
    ? await seasonStore.get(ctx.team.seasonId, { type: 'json' }).catch(() => null)
    : null;
  const WEEKS = seasonData?.weeks || 8;
  const ROUNDS_PER_MATCH = seasonData?.roundsPerMatch || 2;
  const GAMES_PER_ROUND = seasonData?.gamesPerRound || 6;
  // Lineups hard-lock this many minutes before match start (default 1 hour), and
  // the matchup reveals this many minutes before start (default 15) — BOTH locked
  // AND inside the reveal window. Season-configurable; keep in sync with
  // [[lineup-system]] and the copy in captain.html / me.html.
  const LINEUP_LOCK_OFFSET_MIN = Number(seasonData?.lineupLockOffsetMin) || DEFAULT_LOCK_OFFSET_MIN;
  const LINEUP_REVEAL_OFFSET_MIN = Number(seasonData?.lineupRevealOffsetMin) || DEFAULT_REVEAL_OFFSET_MIN;

  // Verify this captain is actually in this match
  const match = await findMatch(scheduleStore, matchId, ctx.team, WEEKS);
  if (!match) return json({ error: 'Match not found or not yours' }, 404);

  const myTeamId = ctx.team.id;
  const oppTeamId = match.teamA.id === myTeamId ? match.teamB.id : match.teamA.id;
  const myKey = `lineup/${matchId}/${myTeamId}.json`;
  const oppKey = `lineup/${matchId}/${oppTeamId}.json`;

  // ========== GET ==========
  if (req.method === 'GET') {
    const [mine, opp] = await Promise.all([
      lineupStore.get(myKey, { type: 'json' }).catch(() => null),
      lineupStore.get(oppKey, { type: 'json' }).catch(() => null),
    ]);

    const myLocked = !!mine?.lockedAt;
    const oppLocked = !!opp?.lockedAt;
    // Simultaneous reveal: both locked AND we're inside the reveal window
    // (15 min before start by default). Locking early no longer reveals early.
    const revealed = myLocked && oppLocked && isRevealTime(match.scheduledAt, LINEUP_REVEAL_OFFSET_MIN);

    // A locked lineup can be reopened by the captain while it's still before the
    // hard-lock window AND the matchup hasn't revealed. The opponent locking no
    // longer blocks unlock: since reveal became time-gated (T-15), both-locked
    // shows nobody anything, so reopening is harmless until the reveal.
    const cutoff = hardLockTime(match.scheduledAt, LINEUP_LOCK_OFFSET_MIN);
    const unlockable = myLocked && !revealed && (cutoff === null || Date.now() < cutoff);
    const revealAt = revealTime(match.scheduledAt, LINEUP_REVEAL_OFFSET_MIN);

    return json({
      matchId,
      myRole: match.teamA.id === myTeamId ? 'home' : 'away',
      myTeam: { id: myTeamId, name: ctx.team.name },
      opponent: {
        id: oppTeamId,
        name: match.teamA.id === myTeamId ? match.teamB.name : match.teamA.name,
      },
      court: match.court || null,
      scheduledAt: match.scheduledAt || null,
      myLineup: mine || null,
      oppLineup: revealed ? sanitizeRevealedLineup(opp) : null,
      status: {
        myLocked, oppLocked, revealed, unlockable,
        hardLockAt: cutoff ? new Date(cutoff).toISOString() : null,
        revealAt: revealAt ? new Date(revealAt).toISOString() : null,
      },
    });
  }

  // ========== PUT ==========
  if (req.method === 'PUT') {
    const body = await req.json();
    const action = ['lock', 'unlock'].includes(body.action) ? body.action : 'save';
    const games = body.games || {};

    // Load current to check lock state
    const existing = await lineupStore.get(myKey, { type: 'json' }).catch(() => null);

    // ========== UNLOCK ==========
    // Reopen a locked lineup for editing — but only while it's safe to do so:
    //   1. it must actually be locked,
    //   2. the matchup must NOT have revealed (post-reveal changes would defeat
    //      the blind-lineup anti-cheat — opponent locking alone no longer blocks
    //      unlock, since the time-gated reveal means nobody has seen anything),
    //   3. we must still be before the hard-lock window (match start − offset).
    // Anything past those points needs an admin override (logged), not self-serve.
    if (action === 'unlock') {
      if (!existing?.lockedAt) {
        return json({ error: 'Lineup is not locked.' }, 409);
      }
      const opp = await lineupStore.get(oppKey, { type: 'json' }).catch(() => null);
      if (opp?.lockedAt && isRevealTime(match.scheduledAt, LINEUP_REVEAL_OFFSET_MIN)) {
        return json({ error: 'The matchup has been revealed and can no longer be unlocked. Ask a league admin if you need a change.' }, 409);
      }
      const cutoff = hardLockTime(match.scheduledAt, LINEUP_LOCK_OFFSET_MIN);
      if (cutoff !== null && Date.now() >= cutoff) {
        return json({ error: `Too close to match time — lineups hard-lock ${formatOffset(LINEUP_LOCK_OFFSET_MIN)} before the match and can no longer be unlocked. Ask a league admin if you need a change.` }, 403);
      }
      const reopened = {
        ...existing,
        lockedAt: null,
        lockedBy: null,
        updatedAt: new Date().toISOString(),
        updatedBy: ctx.user.email,
      };
      await lineupStore.setJSON(myKey, reopened);
      await logActivity({
        type: 'lineup.unlocked',
        actor: { email: ctx.user.email, role: ctx.user.role },
        team: ctx.team,
        matchId, week: match.week, circuit: circuitCode(ctx.team.circuit),
        details: `${ctx.team.name} reopened their Week ${match.week} lineup`,
      });
      return json({ ok: true, locked: false, revealed: false, myLineup: reopened, oppLineup: null });
    }

    if (existing?.lockedAt) {
      return json({ error: 'Lineup is already locked and cannot be changed' }, 409);
    }

    // Optimistic concurrency: the client echoes back the updatedAt it loaded.
    // If it no longer matches what's stored (co-captain saved in the meantime),
    // reject instead of silently overwriting their changes. Only enforced when
    // the client actually sends the field, so older cached frontends keep working.
    if ('updatedAt' in body) {
      const clientStamp = body.updatedAt ?? null;
      const serverStamp = existing?.updatedAt ?? null;
      if (clientStamp !== serverStamp) {
        return json({ error: 'conflict', message: 'Lineup was updated by someone else — please refresh.' }, 409);
      }
    }

    // Resolve roster for validation
    const roster = ctx.team.roster || [];
    const rosterById = new Map(roster.map(p => [p.id, p]));

    // Before a lock, make sure the roster can physically fill a legal lineup —
    // a clear up-front message beats twelve per-slot "missing players" errors.
    if (action === 'lock') {
      const shortfall = checkRosterDepth(roster);
      if (shortfall) return json({ error: shortfall }, 400);
    }

    // Validate all 12 slots if locking, allow partial if drafting
    const normalizedGames = {};
    for (const slot of SLOT_KEYS) {
      const slotDef = SLOT_RULES[slot];
      const entry = games[slot];
      if (!entry) {
        if (action === 'lock') {
          return json({ error: `Missing players for ${prettySlot(slot)}` }, 400);
        }
        continue;
      }

      const p1Id = entry.p1;
      const p2Id = entry.p2;
      if (!p1Id || !p2Id) {
        if (action === 'lock') {
          return json({ error: `${prettySlot(slot)} needs two players` }, 400);
        }
        normalizedGames[slot] = { p1: p1Id || null, p2: p2Id || null };
        continue;
      }

      if (p1Id === p2Id) {
        return json({ error: `${prettySlot(slot)} has the same player twice` }, 400);
      }

      const p1 = rosterById.get(p1Id);
      const p2 = rosterById.get(p2Id);
      if (!p1 || !p2) {
        return json({ error: `${prettySlot(slot)} has a player not on the roster` }, 400);
      }

      // Gender enforcement — block lock if either player has no gender set
      if (!p1.gender || !['M', 'F'].includes(p1.gender)) {
        return json({ error: `${p1.name} needs a gender set in the roster before they can be in a lineup` }, 400);
      }
      if (!p2.gender || !['M', 'F'].includes(p2.gender)) {
        return json({ error: `${p2.name} needs a gender set in the roster before they can be in a lineup` }, 400);
      }

      const gcheck = checkSlotGender(slotDef, p1.gender, p2.gender);
      if (!gcheck.ok) {
        return json({ error: `${prettySlot(slot)}: ${gcheck.reason}` }, 400);
      }

      // Woman-first ordering for mixed: store the woman as p1 every time, for
      // consistent display on both the lineup builder and the revealed scoresheet.
      normalizedGames[slot] = orderMixedWomanFirst(slotDef, p1Id, p2Id, (id) => rosterById.get(id)?.gender);
    }

    // Nightly per-player game cap (blocks save and lock — a draft can't exceed it either)
    const capErr = checkGameCap(normalizedGames, (id) => rosterById.get(id)?.name);
    if (capErr) return json({ error: capErr }, 400);

    // Back-to-back combo check within the same round (blocks save always, not just lock)
    const comboErr = checkBackToBackCombos(normalizedGames, rosterById);
    if (comboErr) return json({ error: comboErr }, 400);

    // Set pairing: g1+g2 / g3+g4 / g5+g6 play simultaneously on two courts —
    // a player can't be in both games of a pair (blocks save AND lock).
    const pairErr = checkSimultaneousPairs(normalizedGames, rosterById);
    if (pairErr) return json({ error: pairErr }, 400);

    // Duplicate-combo check: within a single round, no two games can have the
    // same pair of players. Across rounds is fine.
    if (action === 'lock') {
      const dupErr = checkDuplicateCombos(normalizedGames, ROUNDS_PER_MATCH, GAMES_PER_ROUND);
      if (dupErr) return json({ error: dupErr }, 400);
    }

    // Build the record — denormalize names so we don't need another round-trip on reveal
    const denormalizedGames = {};
    for (const [slot, picks] of Object.entries(normalizedGames)) {
      const p1 = picks.p1 ? rosterById.get(picks.p1) : null;
      const p2 = picks.p2 ? rosterById.get(picks.p2) : null;
      denormalizedGames[slot] = {
        p1: picks.p1,
        p2: picks.p2,
        p1Name: p1?.name || null,
        p2Name: p2?.name || null,
      };
    }

    const record = {
      matchId,
      teamId: myTeamId,
      teamName: ctx.team.name,
      games: denormalizedGames,
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.user.email,
      lockedAt: action === 'lock' ? new Date().toISOString() : null,
      lockedBy: action === 'lock' ? ctx.user.email : null,
    };

    await lineupStore.setJSON(myKey, record);

    if (action === 'lock') {
      await logActivity({
        type: 'lineup.locked',
        actor: { email: ctx.user.email, role: ctx.user.role },
        team: ctx.team,
        matchId, week: match.week, circuit: circuitCode(ctx.team.circuit),
        details: `${ctx.team.name} locked their Week ${match.week} lineup`,
      });
    }

    // Re-check reveal status after save (both locked AND inside the reveal window)
    const opp = await lineupStore.get(oppKey, { type: 'json' }).catch(() => null);
    const revealed = !!record.lockedAt && !!opp?.lockedAt
      && isRevealTime(match.scheduledAt, LINEUP_REVEAL_OFFSET_MIN);

    return json({
      ok: true,
      locked: !!record.lockedAt,
      revealed,
      myLineup: record,
      oppLineup: revealed ? sanitizeRevealedLineup(opp) : null,
    });
  }

  return new Response('Method not allowed', { status: 405 });
};

async function findMatch(scheduleStore, matchId, team, weeks = 8) {
  const circuit = circuitCode(team.circuit);
  for (let week = 1; week <= weeks; week++) {
    const key = `schedule/${circuit}/${team.division}/week-${week}.json`;
    const data = await scheduleStore.get(key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m && (m.teamA?.id === team.id || m.teamB?.id === team.id)) {
      return { ...m, week };
    }
  }
  return null;
}


function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-lineup' };
