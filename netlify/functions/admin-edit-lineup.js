// =============================================================
// /api/admin-edit-lineup — admin "edit who played"
//
// League emergency policy (Richard, 2026-06-07): if a substitution is
// agreed BY BOTH CAPTAINS AT THE COURT (no-show/injury), the games are
// played as agreed and the admin corrects the lineup records afterwards —
// typically the following day, after the match is finalized. Scores are
// NEVER touched by this tool (unlike admin-unlock-lineups, which wipes
// them); player stats/DSR are rebuilt so credit goes to who actually played.
//
// GET  ?match=<matchId>
//   → { match: { id, week, circuit, finalizedAt, scheduledAt,
//                home:{id,name}, away:{id,name} },
//       lineups: { <teamId>: { games, lockedAt } | null },
//       rosters: { <teamId>: [{ id, name, gender }] } }
//
// POST body { matchId, teamId, games: { <slot>: { p1, p2 } }, reason, force? }
//   - games may be PARTIAL — provided slots are merged over the existing
//     lineup, so a single-game swap is one slot.
//   - reason is REQUIRED (goes to the activity log — the audit trail that
//     keeps the override from becoming a loophole).
//   - Hard errors (never bypassed): player not on roster, same player twice,
//     wrong gender for the slot.
//   - Soft rule violations (4-game cap, simultaneous-court pairs,
//     back-to-back/duplicate combos) return 409 { warning } unless
//     force:true — admin can override everything, with friction + logging.
//
// Admin-only.
// =============================================================

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { rebuildStandings } from './lib/standings.js';
import { logActivity } from './lib/activity-log.js';
import {
  SLOT_RULES, checkSlotGender, checkBackToBackCombos,
  checkSimultaneousPairs, checkDuplicateCombos, prettySlot,
} from './lib/lineup-helpers.js';
import { orderMixedWomanFirst, checkGameCap } from './lib/lineup-rules.js';

export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  const url = new URL(req.url);

  // ========== GET — everything the edit modal needs ==========
  if (req.method === 'GET') {
    const matchId = url.searchParams.get('match');
    if (!matchId) return json({ error: 'match id required' }, 400);

    const found = await findMatch(matchId);
    if (!found) return json({ error: 'Match not found' }, 404);
    const { match, circuit } = found;

    const teamsStore = getStore('teams');
    const lineupStore = getStore('lineups');
    const ids = [match.teamA?.id, match.teamB?.id].filter(Boolean);

    const lineups = {}, rosters = {};
    for (const id of ids) {
      const lu = await lineupStore.get(`lineup/${matchId}/${id}.json`, { type: 'json' }).catch(() => null);
      lineups[id] = lu ? { games: lu.games || {}, lockedAt: lu.lockedAt || null } : null;
      const team = await teamsStore.get(`team/${id}.json`, { type: 'json' }).catch(() => null);
      rosters[id] = (team?.roster || []).map(p => ({ id: p.id, name: p.name, gender: p.gender || null }));
    }

    return json({
      match: {
        id: match.id, week: found.week, circuit,
        finalizedAt: match.finalizedAt || null,
        scheduledAt: match.scheduledAt || null,
        home: { id: match.teamA?.id || null, name: match.teamA?.name || 'Home' },
        away: { id: match.teamB?.id || null, name: match.teamB?.name || 'Away' },
      },
      lineups, rosters,
    });
  }

  // ========== POST — apply the edit ==========
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  const { matchId, teamId } = body;
  const reason = String(body.reason || '').trim();
  const force = !!body.force;
  const edits = body.games || {};

  if (!matchId || !teamId) return json({ error: 'matchId and teamId required' }, 400);
  if (!reason) return json({ error: 'A reason is required — it goes in the activity log (e.g. "injury sub agreed at court, both captains").' }, 400);
  if (!Object.keys(edits).length) return json({ error: 'No lineup changes provided' }, 400);

  const found = await findMatch(matchId);
  if (!found) return json({ error: 'Match not found' }, 404);
  const { match, circuit } = found;
  if (match.teamA?.id !== teamId && match.teamB?.id !== teamId) {
    return json({ error: 'That team is not in this match' }, 400);
  }

  const teamsStore = getStore('teams');
  const team = await teamsStore.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
  if (!team) return json({ error: 'Team not found' }, 404);
  const rosterById = new Map((team.roster || []).map(p => [p.id, p]));

  const lineupStore = getStore('lineups');
  const key = `lineup/${matchId}/${teamId}.json`;
  const existing = await lineupStore.get(key, { type: 'json' }).catch(() => null);

  // Merge: provided slots over the existing games (partial edits welcome).
  const merged = {};
  for (const [slot, g] of Object.entries(existing?.games || {})) {
    merged[slot] = { p1: g?.p1 || null, p2: g?.p2 || null };
  }
  for (const [slot, g] of Object.entries(edits)) {
    if (!(slot in SLOT_RULES)) return json({ error: `Unknown game slot: ${slot}` }, 400);
    merged[slot] = { p1: g?.p1 || null, p2: g?.p2 || null };
  }

  // ── Hard checks: roster membership, distinct players, slot gender ──
  for (const [slot, picks] of Object.entries(merged)) {
    const { p1, p2 } = picks;
    if (!p1 && !p2) continue;
    if (!p1 || !p2) return json({ error: `${prettySlot(slot)} needs two players` }, 400);
    if (p1 === p2) return json({ error: `${prettySlot(slot)} has the same player twice` }, 400);
    const a = rosterById.get(p1), b = rosterById.get(p2);
    if (!a || !b) return json({ error: `${prettySlot(slot)} has a player not on ${team.name}'s roster — add them to the roster first` }, 400);
    const gcheck = checkSlotGender(SLOT_RULES[slot], a.gender, b.gender);
    if (!gcheck.ok) return json({ error: `${prettySlot(slot)}: ${gcheck.reason}` }, 400);
    merged[slot] = orderMixedWomanFirst(SLOT_RULES[slot], p1, p2, (id) => rosterById.get(id)?.gender);
  }

  // ── Soft checks: admin may force past these (logged) ──
  if (!force) {
    const nameOf = (id) => rosterById.get(id)?.name;
    const warning = checkGameCap(merged, nameOf)
      || checkSimultaneousPairs(merged, rosterById)
      || checkBackToBackCombos(merged, rosterById)
      || checkDuplicateCombos(merged);
    // `error` carries the text (the admin client's apiJSON surfaces d.error);
    // `forceable` tells the UI it may retry with force:true.
    if (warning) return json({ error: warning, warning, forceable: true }, 409);
  }

  // ── Write: names denormalized, scores untouched, edit audited on-blob ──
  const now = new Date().toISOString();
  const games = {};
  for (const [slot, picks] of Object.entries(merged)) {
    games[slot] = {
      p1: picks.p1 || null,
      p2: picks.p2 || null,
      p1Name: picks.p1 ? (rosterById.get(picks.p1)?.name || null) : null,
      p2Name: picks.p2 ? (rosterById.get(picks.p2)?.name || null) : null,
    };
  }

  const record = {
    ...(existing || { matchId, teamId, teamName: team.name }),
    teamName: team.name,
    games,
    updatedAt: now,
    updatedBy: admin.email || 'admin',
    // If the team never locked (rare emergency path), the admin edit locks it —
    // a corrected matchup is set, and reveal/scoring both need lockedAt.
    lockedAt: existing?.lockedAt || now,
    lockedBy: existing?.lockedAt ? existing.lockedBy : (admin.email || 'admin'),
    adminEdits: [
      ...(existing?.adminEdits || []),
      { at: now, by: admin.email || 'admin', reason, slots: Object.keys(edits), forced: force },
    ],
  };
  await lineupStore.setJSON(key, record);

  await logActivity({
    type: 'lineup.admin-edited',
    actor: { email: admin.email, role: 'admin' },
    team: { id: team.id, name: team.name, circuit: team.circuit, seasonId: team.seasonId },
    matchId, week: found.week, circuit,
    details: `Admin edited ${team.name}'s Week ${found.week} lineup (${Object.keys(edits).join(', ')})${force ? ' [rules overridden]' : ''} — reason: ${reason}`,
  });

  // Player stats/DSR are computed from lineups — rebuild so credit moves to
  // who actually played. MUST be awaited (serverless freezes on response).
  let standingsRebuilt = false;
  if (match.finalizedAt && circuit) {
    try { await rebuildStandings(circuit); standingsRebuilt = true; }
    catch (e) { console.error('rebuildStandings after lineup edit failed:', e); }
  }

  return json({ ok: true, matchId, teamId, slotsChanged: Object.keys(edits), standingsRebuilt });
};

// Locate a match by id across all schedule blobs (admin has no team context).
async function findMatch(matchId) {
  const store = getStore('schedule');
  const { blobs } = await store.list({ prefix: 'schedule/' });
  for (const b of blobs) {
    const data = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m) return { match: m, week: data.week || m.week || 1, circuit: data.circuit || null, key: b.key };
  }
  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/admin-edit-lineup' };
