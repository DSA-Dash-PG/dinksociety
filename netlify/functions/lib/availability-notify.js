// netlify/functions/lib/availability-notify.js
//
// Email the captain + co-captains when a player's availability CHANGES, so they
// know who's in/out without logging in. The email carries a "Set your lineup"
// button back into the captain portal — completing the loop from "player replies"
// to "captain sets the roster". Shared by:
//   · player-availability.js       (player toggles in the portal)
//   · availability-confirm.js      (player taps the one-tap reminder link)
//
// The reverse direction lives here too: notifyPlayerOfCaptainChange tells the
// PLAYER when their captain set the status for them (captain-availability.js).
//
// Recipients exclude whoever just acted (a captain marking themselves doesn't
// need their own email; co-captains still get it). Best-effort — never fatal.

import { getStore } from '@netlify/blobs';
import { getTeamAvailability } from './availability.js';
import { signAvailabilityToken } from './availability-token.js';
import { sendEmail, renderAvailabilityNotify, renderAvailabilitySetByCaptain } from './email.js';

const TZ = 'America/Los_Angeles';

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

/**
 * @param {object}  p
 * @param {object}  p.team    full team blob (roster, captainEmail, emoji)
 * @param {object}  p.player  the player whose status changed ({ name })
 * @param {string}  p.actingEmail  who performed the change (excluded from recipients)
 * @param {object}  p.match   the match ({ id, week, scheduledAt, court, teamA, teamB })
 * @param {'in'|'out'} p.status
 * @param {string}  [p.reason]
 */
export async function notifyCaptainsOfChange({ team, player, actingEmail, match, status, reason }) {
  const recips = new Set();
  const add = (e) => { const x = (e || '').trim().toLowerCase(); if (x) recips.add(x); };
  add(team.captainEmail);
  for (const p of (team.roster || [])) {
    if ((p.isCaptain || p.isCoCaptain) && p.email) add(p.email);
  }
  recips.delete((actingEmail || '').trim().toLowerCase());
  if (!recips.size) return;

  const { opponent, oppEmoji, dateLine } = await matchContext(team, match);

  // Teammates still with no response (assumed available) — surfaced so the captain
  // can nudge them. Subs and archived players excluded.
  const rec = await getTeamAvailability(match.id, team.id);
  const recPlayers = rec.players || {};
  const shortNm = (n) => { const p = String(n || '').trim().split(/\s+/); return p[0] + (p[1] ? ' ' + p[1][0] + '.' : ''); };
  const unconfirmed = (team.roster || [])
    .filter(p => !p.archived && !p.isSub && !recPlayers[p.id])
    .map(p => shortNm(p.name));

  const html = renderAvailabilityNotify({
    playerName: player.name, status, teamName: team.name, teamEmoji: team.emoji || '',
    opponentName: opponent?.name || 'your opponent', oppEmoji,
    week: match.week, dateLine, reason, unconfirmed,
    portalUrl: `${siteUrl()}/captain.html`,
  });
  const subject = status === 'out'
    ? `${player.name} can't make Week ${match.week}`
    : `${player.name} is in for Week ${match.week}`;

  await Promise.allSettled([...recips].map(to => sendEmail({ to, subject, html })));
}

/**
 * Tell the PLAYER that their captain set their availability for them. The player
 * never touched the portal in this flow, so without this they'd have no idea
 * they'd been pulled from the lineup. The email carries a one-tap link to the
 * OPPOSITE status so a wrong entry is theirs to fix.
 *
 * No-ops when the captain is acting on their own record. Best-effort — the
 * caller should never let a mail failure fail the availability write.
 *
 * @param {object}  p
 * @param {object}  p.team    full team blob (roster, emoji)
 * @param {object}  p.player  roster entry whose status changed ({ id, name, email })
 * @param {object}  p.match   the match ({ id, week, scheduledAt, court, teamA, teamB })
 * @param {'in'|'out'} p.status
 * @param {string}  [p.reason]
 * @param {string}  [p.actingEmail]  the captain who made the change
 * @param {string}  [p.byName]       display name for the captain
 */
export async function notifyPlayerOfCaptainChange({ team, player, match, status, reason, actingEmail, byName }) {
  const to = (player?.email || '').trim().toLowerCase();
  if (!to) return;                                              // no email on file
  if (to === (actingEmail || '').trim().toLowerCase()) return;   // captain set their own

  const { opponent, oppEmoji, dateLine } = await matchContext(team, match);

  // Link flips them to the other status.
  const fixUrl = `${siteUrl()}/.netlify/functions/availability-confirm?t=` +
    encodeURIComponent(signAvailabilityToken({
      matchId: match.id, teamId: team.id, playerId: player.id,
      status: status === 'out' ? 'in' : 'out',
    }));

  const html = renderAvailabilitySetByCaptain({
    playerName: player.name, status, teamName: team.name, teamEmoji: team.emoji || '',
    opponentName: opponent?.name || 'your opponent', oppEmoji,
    week: match.week, dateLine, reason, byName, fixUrl,
  });
  const subject = status === 'out'
    ? `You're marked out for Week ${match.week}`
    : `You're marked in for Week ${match.week}`;

  await sendEmail({ to, subject, html });
}

/** Opponent + emoji + "Week N · Mon, Jun 22 · 7:00 PM · Courts 5 & 7" for the match card. */
async function matchContext(team, match) {
  const isA = match.teamA?.id === team.id;
  const opponent = isA ? match.teamB : match.teamA;
  let oppEmoji = '';
  if (opponent?.id) {
    const oppTeam = await getStore('teams').get(`team/${opponent.id}.json`, { type: 'json' }).catch(() => null);
    oppEmoji = oppTeam?.emoji || '';
  }

  const parts = [`Week ${match.week}`];
  if (match.scheduledAt) {
    const d = new Date(match.scheduledAt);
    if (!isNaN(d)) parts.push(d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ,
    }));
  }
  if (match.court) parts.push(match.court);
  return { opponent, oppEmoji, dateLine: parts.join(' · ') };
}
