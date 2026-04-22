// netlify/functions/captain-lineup.js
// GET   ?match=<id>                → captain's own lineup + status (opponent hidden until both locked)
// PUT   ?match=<id>                → save/update draft OR lock the lineup
//                                     body: { games: {...}, action: 'save' | 'lock' }
//
// Enforces slot gender rules strictly:
//   Round 1 & 2 each have 6 games in this order:
//     g1 = Women's Doubles  (both players F)
//     g2 = Men's Doubles    (both players M)
//     g3-g6 = Mixed Doubles (one M + one F)

import { getStore } from '@netlify/blobs';
import { requireCaptain, unauthResponse } from './lib/captain-auth.js';

const SLOT_RULES = {
  r1g1: 'WOMENS', r1g2: 'MENS', r1g3: 'MIXED', r1g4: 'MIXED', r1g5: 'MIXED', r1g6: 'MIXED',
  r2g1: 'WOMENS', r2g2: 'MENS', r2g3: 'MIXED', r2g4: 'MIXED', r2g5: 'MIXED', r2g6: 'MIXED',
};
const SLOT_KEYS = Object.keys(SLOT_RULES);

export default async (req) => {
  const ctx = await requireCaptain(req);
  if (!ctx) return unauthResponse();

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const scheduleStore = getStore('schedule');
  const lineupStore = getStore('lineups');

  // Verify this captain is actually in this match
  const match = await findMatch(scheduleStore, matchId, ctx.team);
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
      status: { myLocked, oppLocked, revealed },
    });
  }

  // ========== PUT ==========
  if (req.method === 'PUT') {
    const body = await req.json();
    const action = body.action === 'lock' ? 'lock' : 'save';
    const games = body.games || {};

    // Load current to check lock state
    const existing = await lineupStore.get(myKey, { type: 'json' }).catch(() => null);
    if (existing?.lockedAt) {
      return json({ error: 'Lineup is already locked and cannot be changed' }, 409);
    }

    // Resolve roster for validation
    const roster = ctx.team.roster || [];
    const rosterById = new Map(roster.map(p => [p.id, p]));

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

      normalizedGames[slot] = { p1: p1Id, p2: p2Id };
    }

    // Back-to-back combo check within the same round (blocks save always, not just lock)
    const comboErr = checkBackToBackCombos(normalizedGames, rosterById);
    if (comboErr) return json({ error: comboErr }, 400);

    // Duplicate-combo check: within a single round, no two games can have the
    // same pair of players. Across rounds is fine.
    if (action === 'lock') {
      const dupErr = checkDuplicateCombos(normalizedGames);
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

async function findMatch(scheduleStore, matchId, team) {
  for (let week = 1; week <= 7; week++) {
    const key = `schedule/${team.circuit}/${team.division}/week-${week}.json`;
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
function checkDuplicateCombos(games) {
  for (const round of [1, 2]) {
    const seen = new Map();
    for (let g = 1; g <= 6; g++) {
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
