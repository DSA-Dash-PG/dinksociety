// netlify/functions/lib/lineup-notify.js
//
// Emails the players in the lineup when a captain LOCKS it, and again when a
// re-lock actually changes someone's games. Called from captain-lineup.js.
//
// ONLY players with games in the current lineup are ever emailed.
//   · in the lineup                → renderLineupPlaying  (their games + full grid)
//   · in it, games changed on re-lock → renderLineupChanged
//   · available, not picked        → nothing
//   · marked OUT                   → nothing
//   · taken out of the lineup on a re-lock → nothing (the captain receipt names
//     them so the captain can tell them directly)
//   · captain + co-captains        → renderLineupReceipt  (who got what + the grid)
//
// Re-lock diffing: we snapshot what was last EMAILED onto the lineup record as
// `notifiedGames`, and diff against that rather than against the previous lock.
// So unlock → re-lock with no real edit sends nothing, and a captain cycling the
// lock three times doesn't send three rounds of mail. A player only hears from
// us when THEIR OWN games changed.
//
// Never includes the opponent's lineup — locking can happen days before the
// game-time reveal and the matchup is blind until then.

import { getStore } from '@netlify/blobs';
import { getTeamAvailability } from './availability.js';
import { SLOT_KEYS, gameNoOf, slotTypeLabel, formatOffset } from './lineup-helpers.js';
import {
  sendEmail, renderLineupPlaying, renderLineupChanged, renderLineupReceipt,
} from './email.js';
import { isActivePlayer } from './roster.js';

const TZ = 'America/Los_Angeles';

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

const norm = (e) => (e || '').trim().toLowerCase();

/** Short type label for the grid: "Women's" | "Men's" | "Mixed". */
function shortType(slot) {
  const t = slotTypeLabel(slot);
  return t.replace(/\s*doubles$/i, '');
}

/**
 * Per-player view of a games map: playerId -> [{ slot, no, typeLabel, partnerId }]
 * sorted by display game number.
 */
export function byPlayer(games) {
  const map = new Map();
  for (const slot of SLOT_KEYS) {
    const g = (games || {})[slot];
    if (!g) continue;
    for (const [me, them] of [[g.p1, g.p2], [g.p2, g.p1]]) {
      if (!me) continue;
      if (!map.has(me)) map.set(me, []);
      map.get(me).push({ slot, no: gameNoOf(slot), typeLabel: shortType(slot), partnerId: them || null });
    }
  }
  for (const list of map.values()) list.sort((a, b) => a.no - b.no);
  return map;
}

/**
 * What changed for ONE player between two games maps.
 * Returns [] when nothing about their night is different.
 */
export function diffForPlayer(prevList, nextList, nameOf) {
  const prev = new Map((prevList || []).map(g => [g.slot, g]));
  const next = new Map((nextList || []).map(g => [g.slot, g]));
  const changes = [];
  for (const [slot, g] of next) {
    const before = prev.get(slot);
    if (!before) {
      changes.push({ kind: 'added', no: g.no, typeLabel: g.typeLabel, partner: nameOf(g.partnerId) });
    } else if (before.partnerId !== g.partnerId) {
      changes.push({
        kind: 'partner', no: g.no, typeLabel: g.typeLabel,
        partner: nameOf(g.partnerId), wasPartner: nameOf(before.partnerId),
      });
    }
  }
  for (const [slot, g] of prev) {
    if (!next.has(slot)) changes.push({ kind: 'dropped', no: g.no, typeLabel: g.typeLabel });
  }
  return changes.sort((a, b) => a.no - b.no);
}

/**
 * Decide who on the roster gets a lineup email. Pure — no I/O.
 *
 * Only players with at least one game in the CURRENT lineup are ever emailed.
 * First send: every one of them. Re-lock: only those whose own games changed.
 * Everyone else is recorded on the summary for the captain receipt and never
 * mailed: not picked (notIn), marked out (skipped), or in the lineup last time
 * and taken out now (removed).
 *
 * @returns {{ sends: Array<{player, mine, changes}>, summary: object }}
 */
export function planLineupEmails({ roster, nextByPlayer, prevByPlayer, isFirstSend, isOut, nameOf, hasEmail }) {
  const sends = [];
  const summary = { playing: [], emailed: [], notIn: [], skipped: [], removed: [], noEmail: [], changed: [] };

  for (const p of roster || []) {
    const mine = nextByPlayer.get(p.id) || [];

    if (!mine.length) {
      if (!isFirstSend && (prevByPlayer.get(p.id) || []).length) summary.removed.push(p.name);
      else if (isOut(p.id)) summary.skipped.push(p.name);
      else summary.notIn.push(p.name);
      continue;
    }

    summary.playing.push(p.name);
    if (!hasEmail(p)) { summary.noEmail.push(p.name); continue; }

    if (isFirstSend) {
      sends.push({ player: p, mine, changes: null });
      summary.emailed.push(p.name);
      continue;
    }

    const changes = diffForPlayer(prevByPlayer.get(p.id), mine, nameOf);
    if (!changes.length) continue;
    summary.changed.push(p.name);
    summary.emailed.push(p.name);
    sends.push({ player: p, mine, changes });
  }

  return { sends, summary };
}

/** "Week 6 · Thu, Jul 23 · 7:00 PM · Courts 5C & 5D" + opponent emoji. */
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

/**
 * Send the lock emails. Best-effort by design — the caller must not let a mail
 * failure fail the lock that already succeeded.
 *
 * @param {object} p
 * @param {object} p.team          full team blob (roster, name, emoji)
 * @param {object} p.match         { id, week, scheduledAt, court, teamA, teamB }
 * @param {object} p.games         the newly locked games map (denormalized)
 * @param {object} [p.notifiedGames] what was last emailed, from the lineup record
 * @param {string} [p.lockedByEmail]
 * @param {number} [p.lockOffsetMin]
 * @returns {Promise<{sent:number, notifiedGames:object, summary:object}>}
 */
export async function notifyTeamOfLock({ team, match, games, notifiedGames, lockedByEmail, lockOffsetMin }) {
  const roster = (team.roster || []).filter(isActivePlayer);
  const nameById = new Map(roster.map(p => [p.id, p.name]));
  const nameOf = (id) => (id ? nameById.get(id) || null : null);

  const avail = await getTeamAvailability(match.id, team.id);
  const isOut = (id) => avail.players?.[id]?.status === 'out';

  const { opponent, oppEmoji, dateLine } = await matchContext(team, match);
  const ctx = {
    teamName: team.name, teamEmoji: team.emoji || '',
    opponentName: opponent?.name || 'your opponent', oppEmoji,
    week: match.week, dateLine, portalUrl: `${siteUrl()}/me`,
  };
  const lockLine = lockOffsetMin
    ? `The lineup hard-locks ${formatOffset(lockOffsetMin)} before start.`
    : '';

  // Full grid, shared by every email.
  const pairOf = (slot) => {
    const g = (games || {})[slot] || {};
    const a = g.p1Name || nameOf(g.p1); const b = g.p2Name || nameOf(g.p2);
    return [a, b].filter(Boolean).join(' & ') || '—';
  };
  const gridFor = (playerId) => SLOT_KEYS.map(slot => {
    const g = (games || {})[slot] || {};
    return {
      no: gameNoOf(slot), round: slot.startsWith('r1') ? 1 : 2,
      typeLabel: shortType(slot), pair: pairOf(slot),
      mine: !!playerId && (g.p1 === playerId || g.p2 === playerId),
    };
  }).sort((a, b) => a.no - b.no);

  const nextByPlayer = byPlayer(games);
  const isFirstSend = !notifiedGames || !Object.keys(notifiedGames).length;
  const prevByPlayer = isFirstSend ? new Map() : byPlayer(notifiedGames);

  const decorate = (list) => (list || []).map(g => ({ ...g, partner: nameOf(g.partnerId) }));

  const plan = planLineupEmails({
    roster, nextByPlayer, prevByPlayer, isFirstSend, isOut, nameOf,
    hasEmail: (p) => !!norm(p.email),
  });
  const { summary } = plan;

  const jobs = [];
  for (const { player: p, mine, changes } of plan.sends) {
    if (isFirstSend) {
      jobs.push(sendEmail({
        to: p.email,
        subject: `Your Week ${match.week} lineup — ${mine.length} game${mine.length === 1 ? '' : 's'} vs ${ctx.opponentName}`,
        html: renderLineupPlaying({ ...ctx, playerName: p.name, myGames: decorate(mine), grid: gridFor(p.id), lockLine }),
      }));
    } else {
      jobs.push(sendEmail({
        to: p.email,
        subject: `Your Week ${match.week} lineup changed`,
        html: renderLineupChanged({ ...ctx, playerName: p.name, changes, myGames: decorate(mine), lockLine }),
      }));
    }
  }

  // Nothing changed for anyone still playing, and nobody was taken out — stay
  // silent entirely.
  if (!isFirstSend && !summary.changed.length && !summary.removed.length) {
    return { sent: 0, notifiedGames: games, summary };
  }

  // Captain + co-captain receipt.
  const capEmails = new Set();
  if (norm(team.captainEmail)) capEmails.add(norm(team.captainEmail));
  for (const p of roster) if ((p.isCaptain || p.isCoCaptain) && norm(p.email)) capEmails.add(norm(p.email));
  if (capEmails.size) {
    const lockedBy = roster.find(p => norm(p.email) === norm(lockedByEmail));
    const receipt = renderLineupReceipt({
      ...ctx, grid: gridFor(null), lockedByName: lockedBy?.name || null,
      playing: summary.playing, emailed: summary.emailed, removed: summary.removed,
      notIn: summary.notIn, skipped: summary.skipped,
      noEmail: summary.noEmail, changed: !isFirstSend,
    });
    const subject = isFirstSend
      ? `Week ${match.week} lineup sent — ${summary.playing.length} playing, ${summary.notIn.length} not in`
      : `Week ${match.week} lineup updated — ${summary.emailed.length} player${summary.emailed.length === 1 ? '' : 's'} notified`;
    for (const to of capEmails) jobs.push(sendEmail({ to, subject, html: receipt }));
  }

  const results = await Promise.allSettled(jobs);
  return {
    sent: results.filter(r => r.status === 'fulfilled').length,
    notifiedGames: games,
    summary,
  };
}
