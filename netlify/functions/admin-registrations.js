// netlify/functions/admin-registrations.js
// Returns all registrations (confirmed + pending + rejected) with full details.
// Admin-only — returns more than the public registration-lookup endpoint.
import { getStore } from '@netlify/blobs';
import { verifyAdminSession, unauthResponse } from './lib/auth.js';
export default async (req) => {
  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  try {
    const store = getStore('registrations');
    const { blobs: confirmedBlobs } = await store.list({ prefix: 'confirmed/' });
    const { blobs: pendingBlobs } = await store.list({ prefix: 'pending/' });
    const { blobs: rejectedBlobs } = await store.list({ prefix: 'rejected/' });
    const confirmed = await Promise.all(
      confirmedBlobs.map(b => store.get(b.key, { type: 'json' }))
    );
    const pending = await Promise.all(
      pendingBlobs.map(b => store.get(b.key, { type: 'json' }))
    );
    const rejected = await Promise.all(
      rejectedBlobs.map(b => store.get(b.key, { type: 'json' }))
    );
    const all = [...confirmed, ...pending, ...rejected]
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Live contact: once a registration is confirmed it is seeded into a team
    // (team.registrationId === reg.id), and the Teams page edits that team — not
    // this signup snapshot. Treat the team as the source of truth for contact so
    // captain email/phone edits show up here. Pending/rejected regs (no team yet)
    // keep their snapshot. We never mutate the registration record.
    const teamsStore = getStore('teams');
    const teamByRegId = new Map();
    try {
      const { blobs: teamBlobs } = await teamsStore.list({ prefix: 'team/' });
      const teams = await Promise.all(
        teamBlobs.map(b => teamsStore.get(b.key, { type: 'json' }).catch(() => null))
      );
      for (const t of teams) {
        if (t?.registrationId) teamByRegId.set(t.registrationId, t);
      }
    } catch { /* non-fatal — fall back to snapshots below */ }

    // For admin we include emails + phone (but scrub Stripe internals)
    const projected = all.map(r => ({
      id: r.id,
      circuit: r.circuit,
      division: r.division,
      divisionLabel: r.divisionLabel,
      path: r.path,
      status: r.status || 'pending',
      amountPaid: r.amountPaid,
      totalPrice: r.totalPrice ?? r.price ?? null,
      depositPaid: r.depositPaid ?? null,
      balanceDue: r.balanceDue ?? null,
      balanceDueDate: r.balanceDueDate ?? null,
      paymentType: r.paymentType ?? null,
      paymentStatus: r.paymentStatus ?? null,
      stripeAmountPaid: r.stripeAmountPaid ?? 0,
      manualPayments: Array.isArray(r.manualPayments) ? r.manualPayments
        : r.manualPayment ? [{ id: 'mp_legacy', amount: r.amountPaid || 0, ...r.manualPayment }]
        : [],
      createdAt: r.createdAt,
      confirmedAt: r.confirmedAt || null,
      approvedBy: r.approvedBy || null,
      rejectedAt: r.rejectedAt || null,
      rejectedBy: r.rejectedBy || null,
      movedAt: r.movedAt || null,
      movedBy: r.movedBy || null,
      team: projectTeam(r, teamByRegId.get(r.id) || null),
      agent: r.agent ? {
        name: r.agent.name,
        email: r.agent.email,
        phone: r.agent.phone || null,
        dupr: r.agent.dupr || null,
        notes: r.agent.notes || null,
      } : null,
    }));
    return new Response(JSON.stringify({ registrations: projected }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('admin-registrations error:', err);
    return new Response(JSON.stringify({ error: 'Failed to load registrations' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
// Build the team contact projection. Prefer the LIVE team roster (the source of
// truth once a registration is confirmed and seeded) over the signup snapshot.
// The admin UI reads the CONTACT column from players[0].email and the captain
// name from team.captain, so we list the captain first.
function projectTeam(r, liveTeam) {
  if (liveTeam) {
    const roster = Array.isArray(liveTeam.roster) ? liveTeam.roster : [];
    const capEmail = (liveTeam.captainEmail || '').toLowerCase();
    const capEntry =
      roster.find(p => p.isCaptain) ||
      (capEmail ? roster.find(p => (p.email || '').toLowerCase() === capEmail) : null);
    const ordered = capEntry ? [capEntry, ...roster.filter(p => p !== capEntry)] : roster;
    return {
      name: liveTeam.name || r.team?.name || null,
      captain: capEntry?.name || liveTeam.captainName || liveTeam.captain || r.team?.captain || null,
      players: ordered.map(p => ({
        name: p.name,
        email: p.email || null,
        phone: p.phone || null,
        captain: !!p.isCaptain,
      })),
      contactSource: 'team',
    };
  }
  if (r.team) {
    return {
      name: r.team.name,
      captain: r.team.players?.[0]?.name || null,
      players: r.team.players?.map(p => ({
        name: p.name,
        email: p.email,
        phone: p.phone || null,
        captain: p.captain || false,
      })) || [],
      contactSource: 'registration',
    };
  }
  return null;
}

export const config = { path: '/.netlify/functions/admin-registrations' };
