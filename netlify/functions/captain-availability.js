// netlify/functions/captain-availability.js
// A captain (or co-captain) views their whole team's availability for a match,
// and can set a player's status on their behalf — handy when someone texts "I'm
// out this week" instead of using the portal.
//
//   GET  ?match=<id>                              → { players: { <pid>: {...} } }
//   PUT  ?match=<id>  { playerId, status, reason? } → set that player's status
//
// Hard-block is enforced where it matters (captain-lineup.js refuses to place an
// 'out' player); this endpoint just owns the availability record itself.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import { getTeamAvailability, setPlayerAvailability } from './lib/availability.js';
import { logActivity } from './lib/activity-log.js';
import { notifyPlayerOfCaptainChange } from './lib/availability-notify.js';

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const teamId = ctx.team.id;

  const url = new URL(req.url);
  const matchId = url.searchParams.get('match');
  if (!matchId) return json({ error: 'match id required' }, 400);

  const match = await findMatch(ctx.team, matchId);
  if (!match) return json({ error: 'Match not found or not yours' }, 404);

  if (req.method === 'GET') {
    const rec = await getTeamAvailability(matchId, teamId);
    return json({ matchId, players: rec.players || {} });
  }

  if (req.method === 'PUT') {
    if (match.finalizedAt) return json({ error: 'This match is already final.' }, 409);

    const body = await req.json().catch(() => ({}));
    const playerId = body.playerId;
    if (!playerId) return json({ error: 'playerId required' }, 400);

    const rp = (ctx.team.roster || []).find(p => p.id === playerId);
    if (!rp) return json({ error: 'Player not on your roster' }, 400);

    const status = body.status === 'out' ? 'out' : body.status === 'in' ? 'in' : null;
    if (!status) return json({ error: "status must be 'in' or 'out'" }, 400);

    const before = await getTeamAvailability(matchId, teamId);
    const prev = before.players?.[playerId]?.status || null;

    const updated = await setPlayerAvailability({
      matchId, teamId, playerId, status, reason: body.reason,
      byEmail: ctx.user.email, byRole: 'captain',
    });

    // Tell the player their captain moved them — they'd otherwise find out at the
    // court. Only on a real change, never for the captain's own record, and never
    // fatal to the write that already succeeded.
    if (prev !== status) {
      const actor = (ctx.team.roster || []).find(
        p => (p.email || '').trim().toLowerCase() === (ctx.user.email || '').trim().toLowerCase());
      try {
        await notifyPlayerOfCaptainChange({
          team: ctx.team, player: rp, match, status,
          reason: updated.players?.[playerId]?.reason,
          actingEmail: ctx.user.email,
          byName: actor?.name || ctx.team.name,
        });
      } catch { /* best-effort */ }
    }

    await logActivity({
      type: 'availability.set',
      actor: { email: ctx.user.email, role: ctx.user.role },
      team: ctx.team, matchId, week: match.week, circuit: circuitCode(ctx.team.circuit),
      details: `${ctx.team.name}: ${rp.name} marked ${status === 'out' ? 'UNAVAILABLE' : 'available'} for Week ${match.week} by captain`,
    }).catch(() => {});

    return json({ ok: true, players: updated.players });
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

export const config = { path: '/.netlify/functions/captain-availability' };
