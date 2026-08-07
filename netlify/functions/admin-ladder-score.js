// netlify/functions/admin-ladder-score.js
// Set one court's score for a ladder round — admin only. Points mode, exactly
// like Pickleladder: winner is the higher score; a TIE has no winner until an
// admin picks one (body.winner 'A'|'B'). Empty scores clear the court.
//
// Editing a round BEFORE the night's current live round ("a past round") is
// allowed, but that round already fed its result into whatever comes after it
// — those later rounds' pairings (and any scores in them) were built from the
// old, wrong result. Doing so requires body.confirmRegenerate:true; without it
// the request is rejected with { requiresConfirm:true, roundsAffected } so the
// UI can warn the admin first and let them confirm. On confirm: every round
// after the edited one is discarded, the very next round is regenerated fresh
// (empty scores) from the corrected result, and the night's live round moves
// back to it — same as if the admin had just now clicked "Next round".
//
//   POST ?event=<id>  { round, court, t1, t2, winner?, confirmRegenerate? }
//   POST ?event=<id>  { round, courts:[{court,t1,t2,winner?}], confirmRegenerate? }

import { unauthResponse } from './lib/auth.js';
import { authScoreAccess } from './lib/ladder-scorer.js';
import { getPlay, setPlay } from './lib/ladder-play.js';
import { getEvent, setEvent } from './lib/ladder.js';
import { genNR } from './lib/ladder-scoring.js';

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }
const num = v => (v === '' || v === null || v === undefined || isNaN(+v)) ? null : Math.trunc(+v);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const eventId = new URL(req.url).searchParams.get('event');
  const auth = await authScoreAccess(req, eventId);
  if (!auth.ok) return unauthResponse('Unauthorized');
  const body = await req.json().catch(() => ({}));
  const ri = parseInt(body.round);
  const play = await getPlay(eventId);
  if (!play) return json({ error: 'No active night.' }, 404);
  const round = play.rounds?.[ri];
  if (!round) return json({ error: 'Round not found.' }, 404);

  const isPastRound = Number.isInteger(play.currentRound) && ri < play.currentRound;

  // Editing a round that's already fed into a later one — make the admin say
  // so explicitly before we discard anything downstream of it.
  if (isPastRound && !body.confirmRegenerate) {
    const roundsAffected = play.rounds.length - (ri + 1);
    return json({
      error: `Round ${ri + 1} already fed into round ${ri + 2}. Fixing it will regenerate round ${ri + 2}`
        + (roundsAffected > 1 ? ` and clear ${roundsAffected} round${roundsAffected === 1 ? '' : 's'} after it` : '')
        + ` using the corrected result.`,
      requiresConfirm: true,
      roundsAffected,
    }, 409);
  }

  // Apply one court's score in-place. Winner = higher score; an exact tie keeps
  // whatever winner was explicitly chosen (else null until one is picked).
  const applyOne = (ci, t1raw, t2raw, winnerRaw) => {
    const court = round.courts?.[ci];
    if (!court) return null;
    const t1 = num(t1raw), t2 = num(t2raw);
    if (t1 === null && t2 === null) { court.score = null; }
    else {
      const winner = (t1 !== null && t2 !== null)
        ? (t1 === t2 ? (winnerRaw === 'A' || winnerRaw === 'B' ? winnerRaw : null) : (t1 > t2 ? 'A' : 'B'))
        : null; // partial entry — no winner yet
      court.score = { t1, t2, winner };
    }
    return { court: ci, score: court.score };
  };

  // Batch: { round, courts:[{court,t1,t2,winner?}] } — every court saved in ONE
  // write (the scoreboard enters all courts, then hits Save once).
  let scores;
  if (Array.isArray(body.courts)) {
    scores = body.courts.map(c => applyOne(parseInt(c.court), c.t1, c.t2, c.winner)).filter(Boolean);
  } else {
    // Single court (used by the tie-break winner picker).
    const one = applyOne(parseInt(body.court), body.t1, body.t2, body.winner);
    if (!one) return json({ error: 'Court not found.' }, 404);
    scores = [one];
  }

  let cascaded = false, roundsCleared = 0;
  if (isPastRound) {
    // Same rule "Next round" enforces live: every court in the fixed round
    // needs a final, non-tied score before we can generate what comes after it.
    const blank = round.courts.filter(c => !c.score || c.score.t1 == null || c.score.t2 == null);
    if (blank.length) return json({ error: `${blank.length} court(s) in round ${ri + 1} still need a final score before regenerating round ${ri + 2}.` }, 400);
    const tied = round.courts.filter(c => !c.score.winner);
    if (tied.length) return json({ error: `${tied.length} tied court(s) in round ${ri + 1} need a winner picked before regenerating round ${ri + 2}.` }, 400);

    roundsCleared = play.rounds.length - (ri + 1);
    play.rounds = play.rounds.slice(0, ri + 1);
    play.rounds.push(genNR(round, play.config.courts));
    play.currentRound = ri + 1;
    cascaded = true;

    // If the night had already been finished, that finalization was based on
    // the now-discarded rounds — reopen it so the corrected play continues.
    if (play.finished) {
      play.finished = false;
      play.finishedAt = null;
      const event = await getEvent(eventId);
      if (event && event.status === 'final') { event.status = 'live'; await setEvent(event); }
    }
  }

  await setPlay(eventId, play);
  return json({ ok: true, scores, cascaded, roundsCleared, play: cascaded ? play : undefined });
};

export const config = { path: '/.netlify/functions/admin-ladder-score' };
