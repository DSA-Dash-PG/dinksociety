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
import { MAX_GAMES_PER_NIGHT, orderMixedWomanFirst, checkGameCap } from './lib/lineup-rules.js';
import { circuitCode } from './lib/circuit.js';

const SLOT_RULES = {
  r1g1: 'WOMENS', r1g2: 'MENS', r1g3: 'MIXED', r1g4: 'MIXED', r1g5: 'MIXED', r1g6: 'MIXED',
  r2g1: 'WOMENS', r2g2: 'MENS', r2g3: 'MIXED', r2g4: 'MIXED', r2g5: 'MIXED', r2g6: 'MIXED',
};
const SLOT_KEYS = Object.keys(SLOT_RULES);

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
  // Lineups hard-lock this many minutes before match start. Season-configurable
  // (default 3 hours) — keep in sync with the reveal offset rules in [[lineup-system]].
  const LINEUP_LOCK_OFFSET_MIN = Number(seasonData?.lineupLockOffsetMin) || 180;

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
    const revealed = myLocked && oppLocked;

    // A locked lineup can be reopened by the captain only while it's still before
    // the hard-lock window AND the opponent hasn't locked (i.e. nothing revealed).
    const cutoff = hardLockTime(match.scheduledAt, LINEUP_LOCK_OFFSET_MIN);
    const unlockable = myLocked && !revealed && (cutoff === null || Date.now() < cutoff);

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
      status: { myLocked, oppLocked, revealed, unlockable, hardLockAt: cutoff ? new Date(cutoff).toISOString() : null },
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
    //   2. the opponent must NOT be locked (once both lock, the matchup is
    //      revealed and changing yours would defeat the blind-lineup anti-cheat),
    //   3. we must still be before the hard-lock window (match start − offset).
    // Anything past those points needs an admin override (logged), not self-serve.
    if (action === 'unlock') {
      if (!existing?.lockedAt) {
        return json({ error: 'Lineup is not locked.' }, 409);
      }
      const opp = await lineupStore.get(oppKey, { type: 'json' }).catch(() => null);
      if (opp?.lockedAt) {
        return json({ error: 'Both lineups are locked and the matchup is revealed — it can no longer be unlocked. Ask a league admin if you need a change.' }, 409);
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
      return json({ ok: true, locked: false, revealed: false, myLineup: reopened, oppLineup: null });
    }

    if (existing?.lockedAt) {
      return json({ error: 'Lineup is already locked and cannot be changed' }, 409);
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

    // Re-check reveal status after save
    const opp = await lineupStore.get(oppKey, { type: 'json' }).catch(() => null);
    const revealed = !!record.lockedAt && !!opp?.lockedAt;

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

/** No two games within the same round can have the same pair of players. */
function checkDuplicateCombos(games, roundsPerMatch = 2, gamesPerRound = 6) {
  for (let round = 1; round <= roundsPerMatch; round++) {
    const seen = new Map();
    for (let g = 1; g <= gamesPerRound; g++) {
      const slot = `r${round}g${g}`;
      const picks = games[slot];
      if (!picks?.p1 || !picks?.p2) continue;
      const key = [picks.p1, picks.p2].sort().join('|');
      if (seen.has(key)) {
        return `Round ${round}: same duo (${slot.toUpperCase()}) already plays in ${seen.get(key).toUpperCase()}. No duplicate combos in the same round.`;
      }
      seen.set(key, slot);
    }
  }
  return null;
}

/**
 * Checks: no duplicate combo (same pair of players) in consecutive games
 * within the same round. Same combo IS allowed across Round 1 & Round 2.
 * Returns an error string if a duplicate is found, else null.
 */
function checkBackToBackCombos(games, rosterById) {
  const rounds = [['r1g1','r1g2','r1g3','r1g4','r1g5','r1g6'],
                  ['r2g1','r2g2','r2g3','r2g4','r2g5','r2g6']];
  for (const round of rounds) {
    const seen = new Set();
    for (const slot of round) {
      const g = games[slot];
      if (!g?.p1 || !g?.p2) continue;
      const key = [g.p1, g.p2].sort().join('|');
      if (seen.has(key)) {
        const p1 = rosterById.get(g.p1)?.name || 'Player 1';
        const p2 = rosterById.get(g.p2)?.name || 'Player 2';
        return `${p1} & ${p2} are already paired earlier in ${slot.startsWith('r1') ? 'Round 1' : 'Round 2'}. Same pair cannot repeat within a round.`;
      }
      seen.add(key);
    }
  }
  return null;
}

function checkSlotGender(slotType, g1, g2) {
  if (slotType === 'WOMENS') {
    if (g1 === 'F' && g2 === 'F') return { ok: true };
    return { ok: false, reason: 'women\u2019s doubles needs two women' };
  }
  if (slotType === 'MENS') {
    if (g1 === 'M' && g2 === 'M') return { ok: true };
    return { ok: false, reason: 'men\u2019s doubles needs two men' };
  }
  if (slotType === 'MIXED') {
    if ((g1 === 'M' && g2 === 'F') || (g1 === 'F' && g2 === 'M')) return { ok: true };
    return { ok: false, reason: 'mixed doubles needs one woman and one man' };
  }
  return { ok: false, reason: 'unknown slot' };
}

/**
 * Checks the roster can physically fill a legal lineup before a lock.
 * Demand is derived from the slot mix + the nightly per-player game cap, so it
 * stays correct if either the slot rules or MAX_GAMES_PER_NIGHT change.
 * Only players with a gender set ('M'/'F') count — gender-less players can't be
 * placed in a slot. Returns a player-facing error string, or null if OK.
 */
function checkRosterDepth(roster) {
  let womenDemand = 0, menDemand = 0;
  for (const type of Object.values(SLOT_RULES)) {
    if (type === 'WOMENS') womenDemand += 2;
    else if (type === 'MENS') menDemand += 2;
    else { womenDemand += 1; menDemand += 1; } // MIXED: one of each
  }
  const minWomen = Math.ceil(womenDemand / MAX_GAMES_PER_NIGHT);
  const minMen = Math.ceil(menDemand / MAX_GAMES_PER_NIGHT);

  const women = (roster || []).filter(p => p.gender === 'F').length;
  const men = (roster || []).filter(p => p.gender === 'M').length;
  if (women >= minWomen && men >= minMen) return null;

  const gaps = [];
  if (women < minWomen) {
    const n = minWomen - women;
    gaps.push(`${n} more ${n > 1 ? 'women' : 'woman'}`);
  }
  if (men < minMen) {
    const n = minMen - men;
    gaps.push(`${n} more ${n > 1 ? 'men' : 'man'}`);
  }
  return `Not enough players to fill a lineup. With a ${MAX_GAMES_PER_NIGHT}-game-per-player cap you need at least ${minWomen} women and ${minMen} men (with a gender set) — you have ${women} ${women === 1 ? 'woman' : 'women'} and ${men} ${men === 1 ? 'man' : 'men'}. Add ${gaps.join(' and ')} to your roster, then lock.`;
}

/**
 * The instant a lineup hard-locks: match start − offset (in minutes).
 * Returns a ms timestamp, or null when the match has no scheduled time (in which
 * case there's no time-based lock to enforce). scheduledAt is an ISO timestamp.
 */
function hardLockTime(scheduledAt, offsetMin) {
  if (!scheduledAt) return null;
  const t = Date.parse(scheduledAt);
  if (Number.isNaN(t)) return null;
  return t - offsetMin * 60000;
}

/** Human-friendly offset, e.g. 180 → "3 hours", 30 → "30 minutes". */
function formatOffset(min) {
  if (min % 60 === 0) {
    const h = min / 60;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  return `${min} minutes`;
}

function prettySlot(slot) {
  const round = slot.startsWith('r1') ? 'Round 1' : 'Round 2';
  const gameNum = slot.slice(-1);
  const type = SLOT_RULES[slot];
  const typeLabel = type === 'WOMENS' ? 'Women\u2019s doubles'
    : type === 'MENS' ? 'Men\u2019s doubles'
    : 'Mixed doubles';
  return `${round} Game ${gameNum} (${typeLabel})`;
}

function sanitizeRevealedLineup(lineup) {
  if (!lineup) return null;
  return {
    teamId: lineup.teamId,
    teamName: lineup.teamName,
    games: lineup.games, // only names + ids, no PII
    lockedAt: lineup.lockedAt,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-lineup' };
