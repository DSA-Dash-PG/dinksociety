// netlify/functions/admin-ladder-round.js
// Run-night round control for a ladder — admin only. Mirrors the Pickleladder
// session flow exactly (genR1 round 1, genNR movement, wave-2 gate, finish at
// the configured round count). Writes to ladder-play; the scoring engine reads
// from there, so DR/standings come out identical.
//
//   GET  ?event=<id>                          → { event, play, roster }
//   POST ?event=<id> { action, ... }
//      'start'    { rounds? }  → genR1 from the paid roster, currentRound 0
//      'next'                  → validate, genNR, currentRound++ (or finish)
//      'wave2'                 → start wave 2 of the current round
//      'reshuffle'             → regenerate the current round (clears its scores)
//      'restart'               → wipe all rounds
//      'finish'                → finalize the night

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { checkLadderPin } from './lib/ladder-pin.js';
import { getEvent, setEvent, getSignups } from './lib/ladder.js';
import { getPlay, setPlay, listPlay, toSession } from './lib/ladder-play.js';
import { genR1, genNR, buildStrengthFn } from './lib/ladder-scoring.js';

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }

// Participant list (engine player shape) from the event's roster.
function participants(signups) {
  return (signups.roster || [])
    .filter(p => p.paymentStatus !== 'cancelled')
    .map(p => ({ id: p.playerId, name: p.name, gender: p.gender === 'F' ? 'F' : 'M' }));
}

async function strengthFor(eventId, players) {
  const prior = (await listPlay()).filter(p => p.finished && p.eventId !== eventId).map(toSession);
  return buildStrengthFn(prior, players);
}

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid && !checkLadderPin(req)) return unauthResponse('Unauthorized');

  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);
  const event = await getEvent(eventId);
  if (!event) return json({ error: 'Ladder not found' }, 404);

  if (req.method === 'GET') {
    const signups = await getSignups(eventId);
    return json({ event, play: await getPlay(eventId), roster: signups.roster });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const body = await req.json().catch(() => ({}));
  const action = body.action;
  const signups = await getSignups(eventId);
  let play = await getPlay(eventId);

  if (action === 'start') {
    const players = participants(signups);
    if (players.length < 4) return json({ error: 'Need at least 4 players on the roster to start.' }, 400);
    const rounds = Math.max(1, Math.min(20, parseInt(body.rounds) || 6));
    const strength = await strengthFor(eventId, players);
    const r1 = genR1(players, event.courts || 1, strength);
    play = { eventId, date: event.date || null, config: { courts: event.courts || 1, rounds, scoreMode: 'points' }, rounds: [r1], currentRound: 0, started: true, finished: false };
    await setPlay(eventId, play);
    if (event.status === 'open') { event.status = 'live'; await setEvent(event); }
    return json({ ok: true, play });
  }

  if (!play || !play.started) return json({ error: 'Night not started yet.' }, 409);
  const cur = play.rounds[play.currentRound];

  if (action === 'wave2') {
    if (cur && cur.wave2started === false) { cur.wave2started = true; await setPlay(eventId, play); }
    return json({ ok: true, play });
  }

  if (action === 'reshuffle') {
    const all = [];
    cur.courts.forEach(c => [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean).forEach(p => all.push(p)));
    const strength = await strengthFor(eventId, participants(signups));
    play.rounds[play.currentRound] = genR1(all, play.config.courts, strength);
    await setPlay(eventId, play);
    return json({ ok: true, play });
  }

  if (action === 'restart') {
    play = { ...play, rounds: [], currentRound: -1, started: false, finished: false };
    await setPlay(eventId, play);
    if (event.status === 'live') { event.status = 'open'; await setEvent(event); }
    return json({ ok: true, play });
  }

  if (action === 'finish') {
    play.finished = true; await setPlay(eventId, play);
    event.status = 'final'; await setEvent(event);
    return json({ ok: true, play });
  }

  if (action === 'next') {
    if (cur && cur.wave2started === false) return json({ error: 'Start Wave 2 before advancing.' }, 409);
    const tied = (cur.courts || []).filter(c => c.score && c.score.t1 !== null && c.score.t2 !== null && !c.score.winner);
    if (tied.length) return json({ error: `${tied.length} tied court(s) need a winner picked.` }, 409);
    if (play.currentRound >= play.config.rounds - 1) {
      play.finished = true; await setPlay(eventId, play);
      event.status = 'final'; await setEvent(event);
      return json({ ok: true, finished: true, play });
    }
    const strength = await strengthFor(eventId, participants(signups));
    play.rounds.push(genNR(cur, play.config.courts, strength));
    play.currentRound++;
    await setPlay(eventId, play);
    return json({ ok: true, play });
  }

  return json({ error: 'unknown action' }, 400);
};

export const config = { path: '/.netlify/functions/admin-ladder-round' };
