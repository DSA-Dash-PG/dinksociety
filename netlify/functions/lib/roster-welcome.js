// netlify/functions/lib/roster-welcome.js
//
// The "you're on a roster" email — sent once per player, ever.
//
// WHEN IT FIRES. Only when someone actually JOINS a roster, never when they're
// requested:
//   captain-roster.js        → a captain adding one of their own past players
//                              (those skip the queue, so they're in immediately)
//   admin-roster-approvals   → the league approving a request
//   admin-registration-confirm → a returning team's carried-over roster
// Being welcomed to a team you were then declined from would be worse than
// silence, which is why a pendingAdd never triggers this.
//
// ONCE, EVER. A captain building a roster saves repeatedly, and the same player
// can be archived and restored. `welcomedAt` on the roster entry is the guard,
// and it is stamped only AFTER the send succeeds — a failed send leaves them
// eligible, so the next save picks them up rather than losing the email.
//
// NEVER LOAD-BEARING. Every failure here is caught and logged. A roster save or
// an approval must not fail because an inbox was unreachable.

import { getStore } from '@netlify/blobs';
import { createPlayerToken } from './player-auth.js';
import { sendEmail, renderRosterWelcome, rosterWelcomeSubject } from './email.js';
import { buildLeagueIndex, playedBefore } from './league-players.js';
import { normalizeEmail } from './identity.js';
import { circuitCode, seasonName, isTestTeam } from './circuit.js';

const TOKEN_DAYS = 7;
const MAX_PER_CALL = 25;

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.app';
}

/**
 * What this player did the last time they played — for the carry-over strip.
 * Reads the player-stats aggregate for the season of their most recent stint,
 * which is keyed by the playerId they had ON THAT TEAM (a returning player gets
 * a new id each season, so the id has to come from the stint, not from now).
 *
 * Returns null when there's nothing worth showing, so the email drops the strip
 * rather than printing a box of dashes.
 */
async function carryOverFor(rec, excludeTeamId) {
  const stints = (rec?.stints || []).filter(s => s.teamId !== excludeTeamId);
  const store = getStore('player-stats');

  for (const stint of stints) {           // already newest-first
    if (!stint.playerId || !stint.circuit) continue;
    const blob = await store
      .get(`player-stats/${stint.circuit}.json`, { type: 'json' })
      .catch(() => null);
    const p = blob?.players?.[stint.playerId];
    if (!p || !p.gamesPlayed) continue;

    return {
      teamName: stint.teamName || '',
      seasonName: stint.seasonName || '',
      record: `${p.gamesWon ?? 0}–${p.gamesLost ?? 0}`,
      // DSR is the 0–100 composite the leaderboard shows, not a 4-digit rating.
      dsr: typeof p.composite === 'number' ? p.composite.toFixed(1) : null,
    };
  }
  return null;
}

/** The "how a league night works" strip for someone who has never played. */
async function leagueNightFor(team) {
  const out = { when: 'Monday nights', format: '2 rounds · 6 games', venue: '' };
  try {
    const seasons = getStore('seasons');
    const id = team.seasonId || `circuit-${circuitCode(team.circuit).toLowerCase()}`;
    const s = await seasons.get(id, { type: 'json' }).catch(() => null);
    if (s?.weeks) out.when = `Monday nights · ${s.weeks} weeks`;
    // Venue is never hardcoded — an empty row is dropped by the renderer.
    if (s?.venue) out.venue = String(s.venue);
    else if (s?.location) out.venue = String(s.location);
  } catch { /* defaults are fine */ }
  return out;
}

/**
 * Send the welcome to specific players on a team, then stamp `welcomedAt`.
 *
 * Re-reads the team with strong consistency (the caller usually wrote it
 * moments ago) and writes once at the end with the stamps applied.
 *
 * @param {{ teamId:string, playerIds:string[], addedByName?:string }} opts
 * @returns {Promise<{sent:number, skipped:number, failed:number}>}
 */
export async function sendRosterWelcomes({ teamId, playerIds, addedByName }) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  const wanted = new Set((playerIds || []).filter(Boolean).map(String));
  if (!teamId || !wanted.size) return result;

  const teams = getStore('teams');
  const key = `team/${teamId}.json`;
  const team = await teams.get(key, { type: 'json', consistency: 'strong' }).catch(() => null);
  if (!team || isTestTeam(team)) return result;

  const targets = (team.roster || []).filter(p =>
    p && wanted.has(String(p.id))
    && !p.pendingAdd && !p.archived     // not on the roster = not welcome-able
    && !p.welcomedAt                    // once, ever
    && normalizeEmail(p.email)
  ).slice(0, MAX_PER_CALL);

  result.skipped = wanted.size - targets.length;
  if (!targets.length) return result;

  const league = await buildLeagueIndex().catch(() => ({ byEmail: new Map() }));
  const site = siteUrl();
  const season = seasonName(team.circuit || team.seasonId);
  const night = await leagueNightFor(team);

  const stamped = [];
  await Promise.all(targets.map(async (player) => {
    try {
      const email = normalizeEmail(player.email);
      const rec = playedBefore(league.byEmail, email);
      // "Returning" = seen anywhere in the league, excluding the team they were
      // just put on. Deliberately looser than the approval rule.
      const priorStints = (rec?.stints || []).filter(s => s.teamId !== team.id);
      const returning = priorStints.length > 0;

      const token = await createPlayerToken({
        email, playerId: player.id, teamId: team.id,
        minutes: TOKEN_DAYS * 24 * 60,
      });

      const html = renderRosterWelcome({
        playerName: player.name || '',
        teamName: team.name || 'your team',
        teamEmoji: team.emoji || '',
        seasonName: season,
        divisionLabel: team.divisionLabel || '',
        addedByName: addedByName || team.captainName || '',
        returning,
        carry: returning ? await carryOverFor(rec, team.id) : null,
        night: returning ? null : night,
        magicUrl: `${site}/.netlify/functions/player-link?token=${token}`,
        siteUrl: site,
      });

      await sendEmail({
        to: email,
        subject: rosterWelcomeSubject({ returning, teamName: team.name || 'your team', seasonName: season }),
        html,
        replyTo: 'dink@dinksociety.app',
      });

      stamped.push(player.id);
      result.sent++;
    } catch (err) {
      result.failed++;
      console.error(`roster-welcome failed for ${player.id}:`, err?.message || err);
    }
  }));

  // Stamp only the ones that actually went out. Re-read so this can't clobber a
  // roster edit made while the emails were in flight.
  if (stamped.length) {
    try {
      const fresh = await teams.get(key, { type: 'json', consistency: 'strong' }).catch(() => null);
      if (fresh) {
        const set = new Set(stamped);
        const now = new Date().toISOString();
        let touched = false;
        for (const p of (fresh.roster || [])) {
          if (p && set.has(p.id) && !p.welcomedAt) { p.welcomedAt = now; touched = true; }
        }
        if (touched) await teams.setJSON(key, fresh);
      }
    } catch (err) {
      // Worst case they get a second welcome on the next save. Better than
      // failing the request that triggered this.
      console.error('roster-welcome stamp failed:', err?.message || err);
    }
  }

  return result;
}

/** Fire-and-log wrapper — for callers that must never fail on an email. */
export function sendRosterWelcomesSafe(opts) {
  return sendRosterWelcomes(opts).catch(err => {
    console.error('roster-welcome batch failed:', err?.message || err);
    return { sent: 0, skipped: 0, failed: 0 };
  });
}
