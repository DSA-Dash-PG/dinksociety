// netlify/functions/lib/league-players.js
//
// WHO THE LEAGUE HAS SEEN BEFORE.
//
// There is no global player table — a "player" is a roster entry embedded in
// team/<id>.json — so the only durable identity across seasons is the
// normalized email (see lib/identity.js). This module builds the cross-season
// index of those entries once and hands it to whoever needs to answer:
//
//   • "has this person played in the league before?"   → approval bypass
//     (captain-roster.js: a returning player is added straight to the roster;
//      only a genuinely new face goes to the admin queue)
//   • "who matches what the captain is typing?"        → captain-player-search.js
//   • "what was this captain's roster last season?"    → registration-returning-team.js
//     and the carry-over at registration (carryOverRoster, below)
//
// A team record is per-season: registering for Season 2 mints a brand-new
// team_<regId> blob, so last season's players are strangers to it. That is why
// identity has to be resolved league-wide rather than per team.
//
// EXCLUSIONS. A `pendingAdd` entry is a REQUEST, not a league member — counting
// it here would let an unapproved add bootstrap itself onto a second roster and
// skip the queue. Archived players DO count: they played, they're known.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';
import { circuitCode, seasonName, isTestTeam } from './circuit.js';

/** Every real team record in the league (test/demo season excluded). */
export async function loadAllTeams({ includeTest = false } = {}) {
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const teams = await Promise.all(
    blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null))
  );
  return teams.filter(t => t && (includeTest || !isTestTeam(t)));
}

/**
 * Sortable season number from anything circuit-ish. seasonName() already
 * resolves 'I' / 'circuit-ii' / 'Season 2' to a display name, so the number
 * falls straight out of it — no second parallel mapping to drift.
 * 'TEST' has no number and sorts last (0).
 */
export function seasonOrder(raw) {
  const m = String(seasonName(raw)).match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * Index every roster entry across every season by normalized email.
 *
 * Returns Map<email, {
 *   email, name, gender, phone, dupr,
 *   stints: [{ teamId, teamName, captainEmail, circuit, seasonName, seasonOrder }],
 *   lastTeamName, lastSeasonName
 * }>
 *
 * Details come from the MOST RECENT season the person appears in (a name or
 * DUPR from Season 2 beats Season 1), but a field only ever filled in an older
 * season is still kept rather than lost to a newer blank.
 */
export function indexLeaguePlayers(teams) {
  const byEmail = new Map();

  for (const team of teams || []) {
    const order = seasonOrder(team.circuit || team.seasonId);
    const stint = {
      teamId: team.id || null,
      teamName: team.name || '',
      captainEmail: normalizeEmail(team.captainEmail),
      circuit: circuitCode(team.circuit || team.seasonId),
      seasonName: seasonName(team.circuit || team.seasonId),
      seasonOrder: order,
    };

    for (const p of (team.roster || [])) {
      if (!p || p.pendingAdd) continue;
      const key = p.normalizedEmail || normalizeEmail(p.email);
      if (!key) continue;

      let rec = byEmail.get(key);
      if (!rec) {
        rec = { email: key, name: '', gender: '', phone: '', dupr: '', stints: [], _latest: -1 };
        byEmail.set(key, rec);
      }
      // playerId is per-stint, not per-person: a returning player gets a fresh
      // id on each season's team record. player-stats blobs are keyed by that
      // id, so carrying it here is the only way to find what someone did last
      // season from the email they came back with.
      rec.stints.push({ ...stint, playerId: p.id || null });

      if (order >= rec._latest) {
        rec._latest = order;
        if (p.name) rec.name = p.name;
        if (p.gender) rec.gender = p.gender;
        if (p.phone) rec.phone = p.phone;
        if (p.dupr) rec.dupr = p.dupr;
      }
      // Don't let a newer blank erase what an older season knew.
      if (!rec.name && p.name) rec.name = p.name;
      if (!rec.gender && p.gender) rec.gender = p.gender;
      if (!rec.phone && p.phone) rec.phone = p.phone;
      if (!rec.dupr && p.dupr) rec.dupr = p.dupr;
    }
  }

  for (const rec of byEmail.values()) {
    rec.stints.sort((a, b) => b.seasonOrder - a.seasonOrder);
    rec.lastTeamName = rec.stints[0]?.teamName || '';
    rec.lastSeasonName = rec.stints[0]?.seasonName || '';
    delete rec._latest;
  }
  return byEmail;
}

/** Teams + the email index in one pass over the blob store. */
export async function buildLeagueIndex(opts) {
  const teams = await loadAllTeams(opts);
  return { teams, byEmail: indexLeaguePlayers(teams) };
}

/** The league record for an email, or null if nobody by that address has played. */
export function playedBefore(byEmail, email) {
  const key = normalizeEmail(email);
  return key ? (byEmail.get(key) || null) : null;
}

/** The stint (if any) where this person played under a given captain. */
export function playedForCaptain(rec, captainEmail) {
  const cap = normalizeEmail(captainEmail);
  if (!rec || !cap) return null;
  return rec.stints.find(s => s.captainEmail === cap) || null;
}

const teamNameKey = n => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Is this past stint the SAME TEAM as the one in hand, across seasons?
 *
 * A team record is per-season, so "the same team" has no id to match on — it
 * has to be inferred, and any one signal alone misses a real case:
 *   • same team id                — the current season
 *   • the recorded prior team     — set when a returning-team registration
 *                                   carried the roster over
 *   • same captain email          — the usual returning captain
 *   • same team name              — covers a squad whose captain changed, or
 *                                   one whose carry-over wasn't used
 *
 * Team-name matching is the loosest of the four. It's safe here because the
 * only thing a match grants is skipping the approval queue — never a write to
 * anyone else's data.
 */
export function sameTeamLineage(stint, team) {
  if (!stint || !team) return false;
  if (stint.teamId && team.id && stint.teamId === team.id) return true;
  if (team.priorTeamId && stint.teamId === team.priorTeamId) return true;
  const cap = normalizeEmail(team.captainEmail);
  if (cap && stint.captainEmail === cap) return true;
  const here = teamNameKey(team.name);
  return !!here && here === teamNameKey(stint.teamName);
}

/** The stint (if any) where this person played for THIS team, in any season. */
export function playedForTeam(rec, team) {
  if (!rec || !team) return null;
  return rec.stints.find(s => sameTeamLineage(s, team)) || null;
}

/**
 * Did this email lead that team — as the team's captainEmail, or as a roster
 * entry flagged captain / co-captain? Co-captains count: the person who
 * registers the team next season isn't always last season's head captain.
 */
export function ledTeam(team, email) {
  const who = normalizeEmail(email);
  if (!team || !who) return false;
  if (normalizeEmail(team.captainEmail) === who) return true;
  return (team.roster || []).some(p =>
    p && (p.isCaptain || p.isCoCaptain) &&
    (p.normalizedEmail || normalizeEmail(p.email)) === who
  );
}

/**
 * The most recent team this person led, newest season first.
 * `excludeCircuit` keeps the season being registered for out of the result, so
 * a half-finished registration can't offer to import from itself.
 */
export function lastTeamLedBy(teams, email, { excludeCircuit = null } = {}) {
  const skip = excludeCircuit ? circuitCode(excludeCircuit) : null;
  const led = (teams || [])
    .filter(t => !(skip && circuitCode(t.circuit || t.seasonId) === skip))
    .filter(t => ledTeam(t, email))
    .sort((a, b) => seasonOrder(b.circuit || b.seasonId) - seasonOrder(a.circuit || a.seasonId));
  return led[0] || null;
}

/** Players on a team who could be carried into a new season. */
export function carryableRoster(team, captainEmail) {
  const cap = normalizeEmail(captainEmail);
  return (team?.roster || [])
    .filter(p => p && !p.pendingAdd && !p.archived)
    // The captain is already on the registration form — don't duplicate them.
    .filter(p => !cap || (p.normalizedEmail || normalizeEmail(p.email)) !== cap)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

/** `jo•••••@gmail.com` — enough for a captain to recognize their own player. */
export function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at < 1) return '';
  const user = s.slice(0, at);
  const head = user.slice(0, Math.min(2, user.length));
  return head + '•'.repeat(Math.max(3, user.length - head.length)) + s.slice(at);
}

/**
 * Rebuild a prior roster server-side for a returning-team registration.
 *
 * The browser is only ever shown MASKED emails, so it sends back player IDs and
 * the real addresses are resolved here. Re-checking that the registrant
 * actually led that team is what stops anyone who knows a team id from
 * harvesting its contact details through the public registration endpoint.
 *
 * Returns registration-shaped player entries, ready to append to team.players.
 */
export async function carryOverRoster({ teamId, playerIds, captainEmail, max = 19 }) {
  const cap = normalizeEmail(captainEmail);
  if (!teamId || !cap) return { players: [], team: null };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(teamId))) return { players: [], team: null };

  const store = getStore('teams');
  const prior = await store.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
  if (!prior || !ledTeam(prior, cap)) return { players: [], team: null };

  const wanted = Array.isArray(playerIds) && playerIds.length
    ? new Set(playerIds.map(String))
    : null; // no explicit selection = bring everyone

  const players = carryableRoster(prior, cap)
    .filter(p => !wanted || wanted.has(String(p.id)))
    .slice(0, max)
    .map(p => ({
      name: p.name || '',
      email: p.email || '',
      phone: p.phone || '',
      gender: p.gender || '',
      dupr: p.dupr || '',
      returning: true,
    }));

  return { players, team: prior };
}
