// netlify/functions/player-availability.js
// A signed-in player marks themselves available / unavailable for one of THEIR
// matches. Default is available, so this only ever needs to be touched to opt
// out (or to opt back in after opting out / after a captain set it).
//
//   GET  ?match=<id>                       → { status:'in'|'out'|null, reason }
//   PUT  ?match=<id>  { status, reason? }   → set my own status for this match
//
// A player can only set their OWN status, and only for a match their team is in,
// up until the match has started (or been finalized).

import { getStore } from '@netlify/blobs';
import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { getTeamAvailability, setPlayerAvailability } from './lib/availability.js';
import { logActivity } from './lib/activity-log.js';
import { sendEmail, renderAvailabilityNotify } from './lib/email.js';

function siteUrl() {
  return (typeof Netlify !== 'undefined' && Netlify.env.get('SITE_URL'))
    || process.env.SITE_URL || 'https://dinksociety.netlify.app';
}

export default async (req) => {
  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const { playerId, teamId, team, player } = ctx;

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  // The match must belong to this player's team.
  const match = await findMatch(team, matchId);
  if (!match) return json({ error: 'Match not found or not yours' }, 404);

  if (req.method === 'GET') {
    const rec = await getTeamAvailability(matchId, teamId);
    const mine = rec.players?.[playerId] || null;
    return json({ matchId, status: mine?.status || null, reason: mine?.reason || '', byRole: mine?.byRole || null });
  }

  if (req.method === 'PUT') {
    if (match.finalizedAt) return json({ error: 'This match is already final.' }, 409);
    if (match.scheduledAt && Date.now() >= new Date(match.scheduledAt).getTime()) {
      return json({ error: 'This match has already started — availability is locked.' }, 409);
    }

    const body = await req.json().catch(() => ({}));
    const status = body.status === 'out' ? 'out' : body.status === 'in' ? 'in' : null;
    if (!status) return json({ error: "status must be 'in' or 'out'" }, 400);

    // Previous status (null = no response = effectively available) — used to
    // decide whether this is a notify-worthy CHANGE.
    const before = await getTeamAvailability(matchId, teamId);
    const prev = before.players?.[playerId]?.status || null;

    const updated = await setPlayerAvailability({
      matchId, teamId, playerId, status, reason: body.reason,
      byEmail: ctx.session?.email || player.email || null, byRole: 'player',
    });
    const mine = updated.players[playerId];

    await logActivity({
      type: 'availability.set',
      actor: { email: ctx.session?.email || player.email, role: 'player' },
      team, matchId, week: match.week, circuit: circuitCode(team.circuit),
      details: `${player.name} marked ${status === 'out' ? 'UNAVAILABLE' : 'available'} for Week ${match.week}`,
    }).catch(() => {});

    // Notify captain + co-captains on a real change: going OUT, or coming BACK in.
    // (No email for no-op re-saves, or first-time "available".) Awaited so the
    // send actually completes before the function returns, but never fatal.
    const goingOut = status === 'out' && prev !== 'out';
    const comingBack = status === 'in' && prev === 'out';
    if (goingOut || comingBack) {
      try { await notifyCaptains({ team, player, acting: ctx.session?.email || player.email, match, status, reason: mine.reason }); }
      catch (e) { console.warn('availability notify failed:', e?.message || e); }
    }

    return json({ ok: true, status: mine.status, reason: mine.reason });
  }

  return new Response('Method not allowed', { status: 405 });
};

// Email the captain + co-captains that a player's availability changed.
// Recipients exclude the person who just acted (a captain marking themselves
// out doesn't need their own email; co-captains still get it).
async function notifyCaptains({ team, player, acting, match, status, reason }) {
  // Recipients: primary captain + any roster co-captains/captains with an email.
  const recips = new Set();
  const add = (e) => { const x = (e || '').trim().toLowerCase(); if (x) recips.add(x); };
  add(team.captainEmail);
  for (const p of (team.roster || [])) {
    if ((p.isCaptain || p.isCoCaptain) && p.email) add(p.email);
  }
  recips.delete((acting || '').trim().toLowerCase());
  if (!recips.size) return;

  // Opponent + emojis for the match card.
  const isA = match.teamA?.id === team.id;
  const opponent = isA ? match.teamB : match.teamA;
  let oppEmoji = '';
  if (opponent?.id) {
    const oppTeam = await getStore('teams').get(`team/${opponent.id}.json`, { type: 'json' }).catch(() => null);
    oppEmoji = oppTeam?.emoji || '';
  }

  // Date line: "Week N · Mon, Jun 22 · 7:00 PM · Courts 5 & 7"
  const parts = [`Week ${match.week}`];
  if (match.scheduledAt) {
    const d = new Date(match.scheduledAt);
    if (!isNaN(d)) parts.push(d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Los_Angeles',
    }));
  }
  if (match.court) parts.push(match.court);
  const dateLine = parts.join(' · ');

  // Teammates who still haven't responded (no record) — assumed available, but
  // surfaced so the captain can nudge them. Archived players excluded.
  const rec = await getTeamAvailability(match.id, team.id);
  const recPlayers = rec.players || {};
  const shortNm = (n) => { const p = String(n || '').trim().split(/\s+/); return p[0] + (p[1] ? ' ' + p[1][0] + '.' : ''); };
  const unconfirmed = (team.roster || [])
    .filter(p => !p.archived && !recPlayers[p.id])
    .map(p => shortNm(p.name));

  const html = renderAvailabilityNotify({
    playerName: player.name, status, teamName: team.name, teamEmoji: team.emoji || '',
    opponentName: opponent?.name || 'your opponent', oppEmoji,
    week: match.week, dateLine, reason, unconfirmed,
    portalUrl: `${siteUrl()}/captain.html`,
  });
  const subject = status === 'out'
    ? `${player.name} can't make Week ${match.week}`
    : `${player.name} is back in for Week ${match.week}`;

  // Send individually so one bad address can't sink the rest.
  await Promise.allSettled([...recips].map(to => sendEmail({ to, subject, html })));
}

async function findMatch(team, matchId) {
  const scheduleStore = getStore('schedule');
  const circuit = circuitCode(team.circuit);
  for (let week = 1; week <= 12; week++) {
    const data = await scheduleStore
      .get(`schedule/${circuit}/${team.division}/week-${week}.json`, { type: 'json' })
      .catch(() => null);
    if (!data?.matches) continue;
    const m = data.matches.find(x => x.id === matchId);
    if (m && (m.teamA?.id === team.id || m.teamB?.id === team.id)) return { ...m, week };
  }
  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/player-availability' };
