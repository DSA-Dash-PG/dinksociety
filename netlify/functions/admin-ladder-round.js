// netlify/functions/admin-ladder-round.js
// Run-night round control for a ladder — admin only. Mirrors the Pickleladder
// session flow exactly (genR1 round 1, genNR movement, wave-2 gate, finish at
// the configured round count). Writes to ladder-play; the scoring engine reads
// from there, so DR/standings come out identical.
//
//   GET  ?event=<id>                          → { event, play, roster }
//   POST ?event=<id> { action, ... }
//      'start'    { rounds? }  → genR1 from the paid roster, currentRound 0
//      'next'                  → validate, genNR, currentRound++ (never auto-finishes —
//                                 the night keeps going past the configured round count
//                                 until someone explicitly hits 'finish')
//      'wave2'                 → start wave 2 of the current round
//      'reshuffle'             → regenerate the current round (clears its scores)
//      'restart-round'         → clear the CURRENT round's scores only (same players/courts)
//      'delete-round'          → discard the current round entirely — none of it counts
//      'restart'               → wipe all rounds
//      'finish'                → finalize the night

import { unauthResponse } from './lib/auth.js';
import { authScoreAccess } from './lib/ladder-scorer.js';
import { getEvent, setEvent, getSignups, setSignups } from './lib/ladder.js';
import { getPlay, setPlay, listPlay, toSession } from './lib/ladder-play.js';
import { genR1, genNR, genR1Pairs, genNRPairs, buildStrengthFn } from './lib/ladder-scoring.js';
import { findPlayerByEmail } from './lib/player-auth.js';

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }

// Participant list (engine player shape) from the event's roster.
function participants(signups) {
  return (signups.roster || [])
    .filter(p => p.paymentStatus !== 'cancelled')
    .map(p => ({ id: p.playerId, name: p.name, gender: p.gender === 'F' ? 'F' : 'M' }));
}

// Fixed Partner: group the roster into locked pairs by .partnerId (set at
// signup — see lib/ladder.js addPairSignup). A player whose partner cancelled
// (no live match for their partnerId) is dropped — they can't play alone in
// this format; the organizer re-pairs or removes them from the manage panel.
function pairsFromRoster(signups) {
  const live = (signups.roster || []).filter(p => p.paymentStatus !== 'cancelled');
  const byId = {}; live.forEach(p => { byId[p.playerId] = p; });
  const seen = new Set(), pairs = [];
  live.forEach(p => {
    if (seen.has(p.playerId)) return;
    const partner = p.partnerId && byId[p.partnerId];
    if (partner && !seen.has(partner.playerId)) {
      seen.add(p.playerId); seen.add(partner.playerId);
      pairs.push({
        p1: { id: p.playerId, name: p.name, gender: p.gender === 'F' ? 'F' : 'M' },
        p2: { id: partner.playerId, name: partner.name, gender: partner.gender === 'F' ? 'F' : 'M' },
      });
    } else {
      seen.add(p.playerId);
    }
  });
  return pairs;
}

// Reconstruct the pairs currently seated on a round's courts (team1/team2 ARE
// the pairs already — used by 'reshuffle' to regenerate without re-fetching
// the roster, so a mid-night sub/manual pairing survives a reshuffle).
function pairsFromRound(round) {
  const pairs = [];
  (round.courts || []).forEach(c => {
    if (c.team1[0] && c.team1[1]) pairs.push({ p1: c.team1[0], p2: c.team1[1] });
    if (c.team2[0] && c.team2[1]) pairs.push({ p1: c.team2[0], p2: c.team2[1] });
  });
  return pairs;
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
    const isPair = event.format === 'fixed-partner';
    let r1;
    if (isPair) {
      const pairs = pairsFromRoster(signups);
      if (pairs.length < 2) return json({ error: 'Need at least 2 paired-up teams on the roster to start.' }, 400);
      r1 = genR1Pairs(pairs, event.courts || 1);
    } else {
      const players = participants(signups);
      if (players.length < 4) return json({ error: 'Need at least 4 players on the roster to start.' }, 400);
      const strength = await strengthFor(eventId, players);
      r1 = genR1(players, event.courts || 1, strength);
    }
    // Default the format from what was set at ladder creation (the merged form);
    // an explicit value in the start request still wins.
    const rounds = Math.max(1, Math.min(20, parseInt(body.rounds) || event.rounds || 10));
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
    if (event.format === 'fixed-partner') {
      play.rounds[play.currentRound] = genR1Pairs(pairsFromRound(cur), play.config.courts);
    } else {
      const all = [];
      cur.courts.forEach(c => [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean).forEach(p => all.push(p)));
      const strength = await strengthFor(eventId, participants(signups));
      play.rounds[play.currentRound] = genR1(all, play.config.courts, strength);
    }
    await setPlay(eventId, play);
    return json({ ok: true, play });
  }

  if (action === 'restart-round') {
    // Clear the CURRENT round's scores — same players, same courts, just a
    // clean scoreboard. Does NOT reshuffle pairings (that's 'reshuffle', a
    // separate action/button). Other rounds are left untouched.
    cur.courts.forEach(c => { c.score = null; });
    if (cur.wave2started === false) cur.wave2started = false;
    await setPlay(eventId, play);
    return json({ ok: true, play });
  }

  if (action === 'delete-round') {
    // Discard the CURRENT round entirely — its courts and any scores already
    // entered are gone, none of it counts. For when a round runs out of time
    // mid-play and shouldn't be scored at all — different from "End ladder
    // early" (finish, which keeps whatever's already been scored this round)
    // and from 'restart-round' above (which keeps the round slot but reshuffles
    // it). Steps back to the previous round; deleting round 1 un-starts the
    // night (same end state as 'restart') since there's no earlier round to
    // land on.
    play.rounds.pop();
    play.currentRound--;
    if (play.currentRound < 0) {
      play = { ...play, rounds: [], currentRound: -1, started: false, finished: false };
      await setPlay(eventId, play);
      if (event.status === 'live') { event.status = 'open'; await setEvent(event); }
      return json({ ok: true, play, unstarted: true });
    }
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
    const courts = cur.courts || [];
    // Ladder movement rule: a court must be fully resolved before anyone moves.
    // Advancing with a blank court used to leave all 4 of its players "in place"
    // in genNR while neighbors still fed in — overflowing one court, starving
    // others, and silently dropping players. Block it here at the source.
    const blank = courts.filter(c => !c.score || c.score.t1 === null || c.score.t1 === undefined || c.score.t2 === null || c.score.t2 === undefined);
    if (blank.length) return json({ error: `${blank.length} court(s) still need a final score before advancing.` }, 409);
    const tied = courts.filter(c => !c.score.winner);
    if (tied.length) return json({ error: `${tied.length} tied court(s) need a winner picked.` }, 409);
    // Reaching the configured round count no longer auto-finishes the night —
    // organizers often keep playing past the planned count. Finishing is now
    // exclusively the deliberate 'finish' action ("End ladder early" / "Finish
    // ladder" button).
    if (event.format === 'fixed-partner') {
      play.rounds.push(genNRPairs(cur, play.config.courts));
    } else {
      const strength = await strengthFor(eventId, participants(signups));
      play.rounds.push(genNR(cur, play.config.courts, strength));
    }
    play.currentRound++;
    await setPlay(eventId, play);
    return json({ ok: true, play });
  }

  return json({ error: 'unknown action' }, 400);
};

export const config = { path: '/.netlify/functions/admin-ladder-round' };
