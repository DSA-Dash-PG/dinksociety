// netlify/functions/organizer-ladders.js
// GET /api/organizer-ladders — the ladders owned by the signed-in organizer,
// with sign-up counts and leaderboard status. Scoped: an organizer only ever
// sees their own events (event.ownerEmail === their email) — never the rest of
// the league.

import { requireOrganizer } from './lib/organizer-auth.js';
import { listEvents, getSignups, effectiveCapacity, spotsLeft } from './lib/ladder.js';
import { normalizeEmail } from './lib/identity.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const org = await requireOrganizer(req);
  if (!org.ok) return json({ error: org.error }, org.status);

  const mine = (await listEvents().catch(() => [])).filter(e => normalizeEmail(e.ownerEmail) === org.email);
  const ladders = await Promise.all(mine.map(async (e) => {
    const s = await getSignups(e.id);
    const roster = s.roster || [];
    return {
      id: e.id, name: e.name, date: e.date, startTime: e.startTime, place: e.place,
      status: e.status, type: e.type, courts: e.courts, capacity: effectiveCapacity(e),
      rounds: e.rounds, feeCents: e.feeCents, venmoHandle: e.venmoHandle,
      leaderboard: e.leaderboard || 'included',
      rosterCount: roster.length,
      paidCount: roster.filter(p => p.paymentStatus === 'paid').length,
      waitlistCount: (s.waitlist || []).length,
      spotsLeft: spotsLeft(e, s),
    };
  }));
  ladders.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return json({ organizer: { email: org.email, name: org.name }, ladders });
};

export const config = { path: '/.netlify/functions/organizer-ladders' };
