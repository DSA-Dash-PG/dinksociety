// netlify/functions/lib/availability-notify.js
//
// Email the captain + co-captains when a player's availability CHANGES, so they
// know who's in/out without logging in. The email carries a "Set your lineup"
// button back into the captain portal — completing the loop from "player replies"
// to "captain sets the roster". Shared by:
//   · player-availability.js       (player toggles in the portal)
//   · availability-confirm.js      (player taps the one-tap reminder link)
//
// Recipients exclude whoever just acted (a captain marking themselves doesn't
// need their own email; co-captains still get it). Best-effort — never fatal.

import { getStore } from '@netlify/blobs';
import { getTeamAvailability } from './availability.js';
import { sendEmail, renderAvailabilityNotify } from './email.js';

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

  // Opponent + emoji for the match card.
  const isA = match.teamA?.id === team.id;
  const opponent = isA ? match.teamB : match.teamA;
  let oppEmoji = '';
  if (opponent?.id) {
    const oppTeam = await getStore('teams').get(`team/${opponent.id}.json`, { type: 'json' }).catch(() => null);
    oppEmoji = oppTeam?.emoji || '';
  }

  // "Week N · Mon, Jun 22 · 7:00 PM · Courts 5 & 7"
  const parts = [`Week ${match.week}`];
  if (match.scheduledAt) {
    const d = new Date(match.scheduledAt);
    if (!isNaN(d)) parts.push(d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ,
    }));
  }
  if (match.court) parts.push(match.court);
  const dateLine = parts.join(' · ');

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
