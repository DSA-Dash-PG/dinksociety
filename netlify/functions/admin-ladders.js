// netlify/functions/admin-ladders.js
// GET /api/admin-ladders  (admin session required)
// Lists every ladder with live signup counts for the admin dashboard.

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { listEvents, getSignups, effectiveCapacity, spotsLeft } from './lib/ladder.js';

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid) return unauthResponse(v.error);

  const events = await listEvents();
  const ladders = await Promise.all(events.map(async (e) => {
    const s = await getSignups(e.id);
    const pendingVenmo = (s.roster || []).filter(p => p.paymentStatus === 'venmo_pending').length;
    const paid = (s.roster || []).filter(p => p.paymentStatus === 'paid').length;
    return {
      id: e.id, name: e.name, date: e.date, startTime: e.startTime, place: e.place,
      status: e.status || 'open', feeCents: e.feeCents,
      capacity: effectiveCapacity(e),
      rosterCount: (s.roster || []).length,
      paidCount: paid,
      waitlistCount: (s.waitlist || []).length,
      spotsLeft: spotsLeft(e, s),
      pendingVenmo,
      pendingClaim: s.pendingClaim ? s.pendingClaim.name : null,
    };
  }));

  return new Response(JSON.stringify({ ladders }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
};

export const config = { path: '/.netlify/functions/admin-ladders' };
