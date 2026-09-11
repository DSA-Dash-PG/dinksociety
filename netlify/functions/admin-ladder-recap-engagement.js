// netlify/functions/admin-ladder-recap-engagement.js
// Per-player engagement for one night's recap email: delivered, opened,
// re-opened, clicked, and whether they clicked through to the write-up.
//
//   GET ?event=<id> → { engagement:{ eventId, players[], totals{}, caveat }, recipients[] }
//
// `recipients` is the draft's send list, so the admin panel can show everyone
// who should have received it — including anyone with no engagement rows yet —
// and offer a per-player resend against the same list.
//
// Same permission model as the rest of the recap admin: an admin, or the
// organizer who owns this ladder.

import { requireLadderOwner, orgErr } from './lib/organizer-auth.js';
import { getEngagement } from './lib/recap-tracking.js';
import { getRecap } from './lib/ladder-recap.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const eventId = new URL(req.url).searchParams.get('event');
  if (!eventId) return json({ error: 'event id required' }, 400);

  const auth = await requireLadderOwner(req, eventId);
  if (!auth.ok) return orgErr(auth);

  const [engagement, rec] = await Promise.all([
    getEngagement(eventId).catch(() => null),
    getRecap(eventId).catch(() => null),
  ]);

  return json({
    engagement: engagement || { eventId, players: [], totals: {}, caveat: '' },
    recipients: (rec?.recipients || []).map(r => ({
      playerId: r.playerId || null, name: r.name || null, email: r.email || null,
    })),
    status: rec?.status || null,
    sentAt: rec?.sentAt || null,
  });
};

export const config = { path: '/.netlify/functions/admin-ladder-recap-engagement' };
