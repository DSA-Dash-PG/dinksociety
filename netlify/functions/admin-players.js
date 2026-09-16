// =============================================================
// GET /api/admin-players
//
// ADMIN-ONLY master list of every league player with contact details:
// team, name, email, phone, and last-login. One row per roster entry
// (a player on two teams appears once per team).
//
// Scope (per product decision):
//   • Excludes the test/demo season (isTestTeam).
//   • INCLUDES archived / removed players (flagged `archived: true`) so the
//     admin has every contact, not just the active roster.
//
// ?include=ladder  → ALSO returns people known only to the ladder side, each
// flagged `source: 'ladder'`, so league-side player pickers can reach a ladder
// regular who has never been on a team. This mirrors admin-ladder-players.js,
// which has always folded the league roster into the ladder search; the reverse
// was missing, so a ladder player was invisible to the league and got retyped
// as a brand-new person — a second identity carrying none of their history.
//
// Opt-in on purpose: the Players tab and the badges grant list want league
// members only, and they call this endpoint without the flag.
//
// Last-login is joined from the activity-log `seen/<email>.json` records
// (the same source the Analytics tab uses).
// =============================================================

import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { isTestTeam, circuitCode } from './lib/circuit.js';
import { normalizeEmail } from './lib/identity.js';
import { listPlay, playersFromPlay } from './lib/ladder-play.js';
import { listEvents, getSignups } from './lib/ladder.js';
import { getDirectory } from './lib/player-directory.js';
import { getMergeMap } from './lib/player-merge.js';

/**
 * Everyone the LADDER side knows: scored play, plus every event roster/waitlist
 * (a player counts the moment they're signed up, not only once a night is
 * scored), with the ladder-players directory overlaid as the curated master
 * record for name / gender / email / DUPR. Same shape and precedence as
 * admin-ladder-players.js so the two lists can't drift apart.
 *
 * Returns [{ id, name, gender, email, dupr, nights, mergedInto }].
 */
async function loadLadderPlayers() {
  const plays = await listPlay().catch(() => []);

  const nightsById = {};                      // playerId -> Set(eventId)
  const addEvt = (id, evId) => { if (id) (nightsById[id] = nightsById[id] || new Set()).add(evId); };
  for (const p of plays) {
    const seen = new Set();
    (p.rounds || []).forEach(r => (r.courts || []).forEach(c =>
      [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean).forEach(pl => seen.add(pl.id))));
    seen.forEach(id => addEvt(id, p.eventId));
  }

  // Signup rows carry the email/DUPR typed in at signup — for an admin-added
  // player that's the only place either one exists unless the directory has it.
  const signupById = {};
  const events = await listEvents().catch(() => []);
  await Promise.all(events.map(async (ev) => {
    const sg = await getSignups(ev.id).catch(() => null);
    if (!sg) return;
    [...(sg.roster || []), ...(sg.waitlist || [])].forEach((pl) => {
      if (!pl || !pl.playerId) return;
      addEvt(pl.playerId, ev.id);
      const cur = signupById[pl.playerId] || (signupById[pl.playerId] =
        { id: pl.playerId, name: pl.name || '', gender: pl.gender || '', email: '', duprId: '' });
      if (!cur.name && pl.name) cur.name = pl.name;
      if (!cur.gender && pl.gender) cur.gender = pl.gender;
      if (!cur.email && pl.email) cur.email = pl.email;
      if (!cur.duprId && pl.duprId) cur.duprId = pl.duprId;
    });
  }));

  const universe = {};
  for (const p of playersFromPlay(plays)) universe[p.id] = { id: p.id, name: p.name, gender: p.gender || '' };
  for (const p of Object.values(signupById)) if (!universe[p.id]) universe[p.id] = p;

  const [dir, merges] = await Promise.all([
    getDirectory().catch(() => ({})),
    getMergeMap().catch(() => ({})),
  ]);

  return Object.values(universe).map(p => ({
    id: p.id,
    name: dir[p.id]?.name || p.name || '',
    gender: dir[p.id]?.gender || p.gender || null,
    email: dir[p.id]?.email || signupById[p.id]?.email || '',
    dupr: dir[p.id]?.duprId || signupById[p.id]?.duprId || null,
    nights: nightsById[p.id] ? nightsById[p.id].size : 0,
    mergedInto: merges[p.id]?.to || null,
  })).filter(p => p.name);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);

  // ── Login activity: seen/<email>.json → { email, lastLoginAt, lastSeenAt } ──
  const actStore = getStore('activity-log');
  const { blobs: seenBlobs } = await actStore.list({ prefix: 'seen/' }).catch(() => ({ blobs: [] }));
  const seen = (await Promise.all(
    seenBlobs.map(b => actStore.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(Boolean);
  const loginByEmail = new Map();
  for (const s of seen) {
    if (!s.email) continue;
    loginByEmail.set(String(s.email).toLowerCase(), { lastLoginAt: s.lastLoginAt || null, lastSeenAt: s.lastSeenAt || null });
  }

  // ── Teams (exclude test/demo), flatten rosters incl. archived players ──
  const teamsStore = getStore('teams');
  const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = (await Promise.all(
    teamBlobs.map(b => teamsStore.get(b.key, { type: 'json' }).catch(() => null))
  )).filter(t => t && !isTestTeam(t));

  const players = [];
  for (const t of teams) {
    const capEmail = (t.captainEmail || '').toLowerCase();
    for (const p of (t.roster || [])) {
      const email = (p.email || '').trim();
      const norm = (p.normalizedEmail || normalizeEmail(email) || email.toLowerCase());
      const login = norm ? loginByEmail.get(norm) : null;
      const isCaptain = capEmail
        ? email.toLowerCase() === capEmail
        : (p.role === 'captain' || p.isCaptain === true);
      players.push({
        source: 'league',
        playerId: p.id || null,
        name: p.name || '',
        teamId: t.id,
        teamName: t.name || '',
        division: t.division || null,
        divisionLabel: t.divisionLabel || t.division || null,
        seasonId: t.seasonId || null,
        // The season code the stats blobs are keyed by, plus DUPR — both used by
        // the "add an existing player" picker so a returning player is linked to
        // their profile instead of being created fresh.
        circuit: t.circuit || null,
        // Resolved once here — the raw field can hold 'I', 'Season 1' or a
        // mangled id, and every client that re-derived it got it wrong.
        circuitCode: circuitCode(t.circuit || t.seasonId),
        dupr: p.dupr || null,
        isCaptain,
        isCoCaptain: p.isCoCaptain === true,
        archived: p.archived === true,
        gender: p.gender || null,
        email: email || null,
        phone: p.phone || null,
        lastLoginAt: login?.lastLoginAt || null,
      });
    }
  }

  // ── Ladder-only players (opt-in) ────────────────────────────────────────
  // Appended, never merged: a person who is on a team AND plays ladder already
  // has a league row, and that row is the one carrying their team and season.
  // Matching is by player id first (the ladder stores the same id when someone
  // was added from the league roster) and then by normalized email, which is
  // the league's identity key (lib/identity.js).
  let ladderOnly = 0;
  const wantLadder = (new URL(req.url).searchParams.get('include') || '')
    .split(',').map(s => s.trim().toLowerCase()).includes('ladder');
  if (wantLadder) {
    try {
      const knownIds = new Set(players.map(p => p.playerId).filter(Boolean));
      const knownEmails = new Set(players.map(p => normalizeEmail(p.email)).filter(Boolean));
      for (const lp of await loadLadderPlayers()) {
        if (lp.mergedInto) continue;                        // an alias, not a person
        if (lp.id && knownIds.has(lp.id)) continue;
        const norm = normalizeEmail(lp.email);
        if (norm && knownEmails.has(norm)) continue;
        players.push({
          source: 'ladder',
          playerId: lp.id || null,
          name: lp.name,
          teamId: null, teamName: null,
          division: null, divisionLabel: null,
          seasonId: null, circuit: null, circuitCode: null,
          dupr: lp.dupr,
          isCaptain: false, isCoCaptain: false,
          archived: false,
          gender: lp.gender,
          email: lp.email || null,
          phone: null,
          ladderNights: lp.nights,
          lastLoginAt: norm ? (loginByEmail.get(norm)?.lastLoginAt || null) : null,
        });
        ladderOnly++;
        if (lp.id) knownIds.add(lp.id);
        if (norm) knownEmails.add(norm);
      }
    } catch (e) {
      // The ladder store having a bad day must never take the league list down.
      console.warn('[admin-players] ladder players unavailable:', e?.message || e);
    }
  }

  players.sort((a, b) => a.name.localeCompare(b.name));

  const stats = {
    total: players.length,
    archived: players.filter(p => p.archived).length,
    withPhone: players.filter(p => p.phone).length,
    neverLoggedIn: players.filter(p => !p.lastLoginAt).length,
    ladderOnly,
  };

  return json({ players, stats });
};

export const config = { path: '/.netlify/functions/admin-players' };
