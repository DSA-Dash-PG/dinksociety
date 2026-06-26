// netlify/functions/public-ladder-night.js
// PUBLIC (no auth) — the live spectator view of one ladder night: roster +
// round pairings + scores. Read-only; never exposes emails or payment data.
//
//   GET /.netlify/functions/public-ladder-night?event=<id>
//     → { event, roster, play }  (or { error } / 404)
//
// Only exposed for ladders that are open / full / live / final (not drafts or
// cancelled). Powers ladder-live.html and the home-screen "live now" card.

import { getEvent, getSignups } from './lib/ladder.js';
import { getPlay } from './lib/ladder-play.js';

const PUBLIC_STATUSES = ['open', 'full', 'live', 'final'];

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);

  try {
    const event = await getEvent(eventId);
    if (!event) return json({ error: 'Ladder not found' }, 404);
    const status = event.status || 'open';
    if (!PUBLIC_STATUSES.includes(status)) return json({ error: 'Ladder not available' }, 404);

    const [signups, play] = await Promise.all([getSignups(eventId), getPlay(eventId)]);

    // Roster: names + gender only, never cancelled, no emails / payment detail.
    const roster = (signups.roster || [])
      .filter(p => p.paymentStatus !== 'cancelled')
      .map(p => ({ id: p.playerId || null, name: p.name || 'Player', gender: p.gender === 'F' ? 'F' : 'M' }));

    // Play: rounds (court pairings + scores), trimmed to the public shape.
    let publicPlay = null;
    if (play && Array.isArray(play.rounds)) {
      publicPlay = {
        started: !!play.started,
        finished: !!play.finished,
        currentRound: Number.isInteger(play.currentRound) ? play.currentRound : 0,
        totalRounds: play.config?.rounds || event.rounds || play.rounds.length || 0,
        courtNames: play.config?.courtNames || event.courtNames || null,
        rounds: play.rounds.map((r, ri) => ({
          round: r.round ?? (ri + 1),
          wave2started: r.wave2started !== false,
          courts: (r.courts || []).map(c => ({
            court: c.court,
            team1: (c.team1 || []).filter(Boolean).map(pl => ({ id: pl.id || null, name: pl.name || '', gender: pl.gender === 'F' ? 'F' : 'M' })),
            team2: (c.team2 || []).filter(Boolean).map(pl => ({ id: pl.id || null, name: pl.name || '', gender: pl.gender === 'F' ? 'F' : 'M' })),
            score: c.score && (c.score.t1 != null || c.score.t2 != null)
              ? { t1: c.score.t1 ?? null, t2: c.score.t2 ?? null, winner: c.score.winner ?? null }
              : null,
          })),
        })),
      };
    }

    const safeEvent = {
      id: event.id, name: event.name || 'Ladder',
      date: event.date || null, startTime: event.startTime || null, endTime: event.endTime || null,
      place: event.place || null, courts: event.courts || null,
      courtNames: event.courtNames || null, type: event.type || 'mixed',
      status, scoreMode: event.scoreMode || 'points', roundMin: event.roundMin || null,
    };

    return json({ event: safeEvent, roster, play: publicPlay });
  } catch (err) {
    console.error('public-ladder-night error:', err);
    return json({ error: 'Unavailable' }, 500);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' },
  });
}

export const config = { path: '/.netlify/functions/public-ladder-night' };
