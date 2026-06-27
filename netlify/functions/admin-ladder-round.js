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

import { unauthResponse } from './lib/auth.js';
import { authScoreAccess } from './lib/ladder-scorer.js';
import { getEvent, setEvent, getSignups, setSignups } from './lib/ladder.js';
import { getPlay, setPlay, listPlay, toSession } from './lib/ladder-play.js';
import { genR1, genNR, buildStrengthFn } from './lib/ladder-scoring.js';
import { findPlayerByEmail } from './lib/player-auth.js';

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
  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);
  const auth = await authScoreAccess(req, eventId);
  if (!auth.ok) return unauthResponse('Unauthorized');
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

  if (action === 'set-email') {
    // Set/clear the email on a player's signup entry so their ladder profile
    // links to their league profile (same email). Independent of play state;
    // creates a manual roster entry if this player isn't on the signup roster.
    const playerId = body.playerId;
    if (!playerId) return json({ error: 'playerId required' }, 400);
    const email = String(body.email || '').trim().toLowerCase();
    let entry = (signups.roster || []).find(p => p.playerId === playerId);
    if (!entry) {
      entry = { playerId, name: String(body.name || '').trim() || 'Player', email: '', gender: body.gender === 'F' ? 'F' : 'M', paymentStatus: 'paid', manual: true, signedUpAt: new Date().toISOString() };
      signups.roster.push(entry);
    }
    entry.email = email;
    signups.eventId = eventId;
    await setSignups(signups);
    let linked = false;
    if (email) { try { linked = !!(await findPlayerByEmail(email)); } catch { linked = false; } }
    return json({ ok: true, email, linked });
  }

  if (action === 'start') {
    const players = participants(signups);
    if (players.length < 4) return json({ error: 'Need at least 4 players on the roster to start.' }, 400);
    // Default the format from what was set at ladder creation (the merged form);
    // an explicit value in the start request still wins.
    const rounds = Math.max(1, Math.min(20, parseInt(body.rounds) || event.rounds || 6));
    const strength = await strengthFor(eventId, players);
    const r1 = genR1(players, event.courts || 1, strength);
    const roundMin = Math.max(1, Math.min(60, parseInt(body.roundMin) || event.roundMin || 12));
    const scoreMode = body.scoreMode || event.scoreMode || 'points';
    const courtNames = Array.isArray(event.courtNames) && event.courtNames.length ? event.courtNames : null;
    play = { eventId, date: event.date || null, config: { courts: event.courts || 1, rounds, roundMin, scoreMode, courtNames }, rounds: [r1], currentRound: 0, started: true, finished: false };
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

  if (action === 'restart-round') {
    // Rebuild ONLY the current round from the LATEST roster — picks up anyone
    // added or removed since the night started, and clears this round's scores.
    // Other rounds (and their scores) are left untouched.
    const players = participants(signups);
    if (players.length < 4) return json({ error: 'Need at least 4 players on the roster.' }, 400);
    const strength = await strengthFor(eventId, players);
    play.rounds[play.currentRound] = genR1(players, play.config.courts, strength);
    await setPlay(eventId, play);
    return json({ ok: true, play });
  }

  if (action === 'add-rounds') {
    // Extend the night by N rounds (so "Next round" keeps going instead of
    // finishing). Doesn't generate them — each is built when you advance.
    const n = Math.max(1, Math.min(10, parseInt(body.n) || 1));
    const base = play.config.rounds || play.rounds.length || 0;
    play.config.rounds = Math.min(30, base + n);
    await setPlay(eventId, play);
    return json({ ok: true, play, rounds: play.config.rounds });
  }

  if (action === 'restart') {
    play = { ...play, rounds: [], currentRound: -1, started: false, finished: false };
    await setPlay(eventId, play);
    if (event.status === 'live') { event.status = 'open'; await setEvent(event); }
    return json({ ok: true, play });
  }

  if (action === 'finish') {
    play.finished = true; play.finishedAt = new Date().toISOString(); await setPlay(eventId, play);
    event.status = 'final'; await setEvent(event);
    return json({ ok: true, play });
  }

  if (action === 'reopen') {
    // Un-finalize a completed night so scores/lineups can be edited, then re-finished.
    play.finished = false; play.finishedAt = null; await setPlay(eventId, play);
    if (event.status === 'final') { event.status = 'live'; await setEvent(event); }
    return json({ ok: true, play });
  }

  if (action === 'swap') {
    // Swap two player slots within a round (MOVE). body: { round, a:{ci,ti,pi}, b:{ci,ti,pi} }
    const ri = parseInt(body.round);
    const rnd = play.rounds?.[ri]; if (!rnd) return json({ error: 'round not found' }, 404);
    const slot = s => { const c = rnd.courts?.[s?.ci]; if (!c) return null; return { team: (parseInt(s.ti) === 0 ? c.team1 : c.team2), pi: parseInt(s.pi) }; };
    const A = slot(body.a), B = slot(body.b);
    if (!A || !B || !A.team || !B.team) return json({ error: 'invalid slots' }, 400);
    const tmp = A.team[A.pi] || null; A.team[A.pi] = B.team[B.pi] || null; B.team[B.pi] = tmp;
    await setPlay(eventId, play);
    return json({ ok: true, play });
  }

  if (action === 'sub') {
    // Replace a player slot (SUB). body: { round, ci, ti, pi, player:{id?,name,gender,temp?}|null }
    const ri = parseInt(body.round);
    const rnd = play.rounds?.[ri]; if (!rnd) return json({ error: 'round not found' }, 404);
    const c = rnd.courts?.[parseInt(body.ci)]; if (!c) return json({ error: 'court not found' }, 404);
    const team = parseInt(body.ti) === 0 ? c.team1 : c.team2;
    const pi = parseInt(body.pi);
    if (body.player === null) { team[pi] = null; }
    else {
      const p = body.player || {};
      const name = String(p.name || '').trim();
      if (!name) return json({ error: 'name required' }, 400);
      team[pi] = { id: p.id || ('p_' + Math.random().toString(36).slice(2, 10)), name, gender: p.gender === 'F' ? 'F' : 'M', ...(p.temp ? { temp: true } : {}) };
    }
    await setPlay(eventId, play);
    return json({ ok: true, play });
  }

  if (action === 'next') {
    if (cur && cur.wave2started === false) return json({ error: 'Start Wave 2 before advancing.' }, 409);
    const tied = (cur.courts || []).filter(c => c.score && c.score.t1 !== null && c.score.t2 !== null && !c.score.winner);
    if (tied.length) return json({ error: `${tied.length} tied court(s) need a winner picked.` }, 409);
    if (play.currentRound >= play.config.rounds - 1) {
      play.finished = true; play.finishedAt = new Date().toISOString(); await setPlay(eventId, play);
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
