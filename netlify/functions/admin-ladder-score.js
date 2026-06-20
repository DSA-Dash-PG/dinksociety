// netlify/functions/admin-ladder-score.js
// Set one court's score for a ladder round — admin only. Points mode, exactly
// like Pickleladder: winner is the higher score; a TIE has no winner until an
// admin picks one (body.winner 'A'|'B'). Empty scores clear the court.
//
//   POST ?event=<id>  { round, court, t1, t2, winner? }

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { getPlay, setPlay } from './lib/ladder-play.js';

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }
const num = v => (v === '' || v === null || v === undefined || isNaN(+v)) ? null : Math.trunc(+v);

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const eventId = new URL(req.url).searchParams.get('event');
  const body = await req.json().catch(() => ({}));
  const ri = parseInt(body.round), ci = parseInt(body.court);
  const play = await getPlay(eventId);
  if (!play) return json({ error: 'No active night.' }, 404);
  const round = play.rounds?.[ri];
  const court = round?.courts?.[ci];
  if (!court) return json({ error: 'Court not found.' }, 404);

  const t1 = num(body.t1), t2 = num(body.t2);
  if (t1 === null && t2 === null) {
    court.score = null;
  } else {
    let winner;
    if (t1 !== null && t2 !== null) {
      winner = t1 === t2 ? (body.winner === 'A' || body.winner === 'B' ? body.winner : null) : (t1 > t2 ? 'A' : 'B');
    } else {
      winner = null; // partial entry — no winner yet
    }
    court.score = { t1, t2, winner };
  }
  await setPlay(eventId, play);
  return json({ ok: true, score: court.score });
};

export const config = { path: '/.netlify/functions/admin-ladder-score' };
