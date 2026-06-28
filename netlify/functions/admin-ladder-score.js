// netlify/functions/admin-ladder-score.js
// Set one court's score for a ladder round — admin only. Points mode, exactly
// like Pickleladder: winner is the higher score; a TIE has no winner until an
// admin picks one (body.winner 'A'|'B'). Empty scores clear the court.
//
//   POST ?event=<id>  { round, court, t1, t2, winner? }

import { unauthResponse } from './lib/auth.js';
import { authScoreAccess } from './lib/ladder-scorer.js';
import { getPlay, setPlay } from './lib/ladder-play.js';

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
  if (Array.isArray(body.courts)) {
    const scores = body.courts.map(c => applyOne(parseInt(c.court), c.t1, c.t2, c.winner)).filter(Boolean);
    await setPlay(eventId, play);
    return json({ ok: true, scores });
  }

  // Single court (used by the tie-break winner picker).
  const one = applyOne(parseInt(body.court), body.t1, body.t2, body.winner);
  if (!one) return json({ error: 'Court not found.' }, 404);
  await setPlay(eventId, play);
  return json({ ok: true, score: one.score });
};

export const config = { path: '/.netlify/functions/admin-ladder-score' };
