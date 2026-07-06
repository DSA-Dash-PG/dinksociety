// netlify/functions/captain-nudge-availability.js
// A captain (or co-captain) manually sends an availability reminder now.
//
//   POST ?match=<id>  { playerId }   → nudge one player
//   POST ?match=<id>  { all: true }  → nudge all unconfirmed regular (non-sub) players
//
// Bypasses the automatic day/window gates (it's an explicit action), but records
// the same per-day marker so the cron won't double-send that day. Subs are never
// auto-reminded, but a captain CAN nudge a specific sub by playerId (e.g. to fill
// a spot).

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { nudgeTeam } from './lib/availability-reminders.js';
import { logActivity } from './lib/activity-log.js';

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const team = ctx.team;

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const match = await findMatch(team, matchId);
  if (!match) return json({ error: 'Match not found or not yours' }, 404);
  if (match.finalizedAt) return json({ error: 'This match is already final.' }, 409);
  if (match.scheduledAt && Date.now() >= new Date(match.scheduledAt).getTime()) {
    return json({ error: 'This match has already started.' }, 409);
  }

  const body = await req.json().catch(() => ({}));
  const playerIds = body.all ? null : (body.playerId ? [body.playerId] : null);
  if (!body.all && !playerIds) return json({ error: 'playerId or all:true required' }, 400);

  const result = await nudgeTeam({ team, match, playerIds });

  await logActivity({
    type: 'availability.nudged',
    actor: { email: ctx.user.email, role: ctx.user.role },
    team, matchId, week: match.week, circuit: circuitCode(team.circuit),
    details: `${team.name}: nudged ${result.sent} player${result.sent === 1 ? '' : 's'} for Week ${match.week}`,
  }).catch(() => {});

  return json({ ok: true, ...result });
};

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
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/captain-nudge-availability' };
