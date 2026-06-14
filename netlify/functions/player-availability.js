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

    const updated = await setPlayerAvailability({
      matchId, teamId, playerId, status, reason: body.reason,
      byEmail: ctx.session?.email || player.email || null, byRole: 'player',
    });

    await logActivity({
      type: 'availability.set',
      actor: { email: ctx.session?.email || player.email, role: 'player' },
      team, matchId, week: match.week, circuit: circuitCode(team.circuit),
      details: `${player.name} marked ${status === 'out' ? 'UNAVAILABLE' : 'available'} for Week ${match.week}`,
    }).catch(() => {});

    const mine = updated.players[playerId];
    return json({ ok: true, status: mine.status, reason: mine.reason });
  }

  return new Response('Method not allowed', { status: 405 });
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
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export const config = { path: '/.netlify/functions/player-availability' };
