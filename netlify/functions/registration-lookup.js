// netlify/functions/registration-lookup.js
// Fetches a confirmed (or still-pending) registration by ID for display on
// the success page. Returns a redacted subset — no full emails, no phone
// numbers, no Stripe session/payment IDs.
//
// Called as: GET /.netlify/functions/registration-lookup?id=<id>
//
// This endpoint is intentionally public (the ID acts as a bearer token —
// anyone with the ID from the Stripe redirect URL can view the registration).
// The ID is 20 hex chars, effectively unguessable.

import { getStore } from '@netlify/blobs';

export default async (req, context) => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
  };

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers,
    });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (!id || !/^[a-f0-9]{16,20}$/.test(id)) {
    return new Response(JSON.stringify({ error: 'Invalid id' }), {
      status: 400, headers,
    });
  }

  try {
    const store = getStore('registrations');

    // Try confirmed first, then fall back to pending (user landed on success
    // page before webhook fired — rare but possible)
    let reg = await store.get(`confirmed/${id}.json`, { type: 'json' });
    let status = 'confirmed';

    if (!reg) {
      reg = await store.get(`pending/${id}.json`, { type: 'json' });
      status = 'pending';
    }

    if (!reg) {
      return new Response(JSON.stringify({ error: 'Registration not found' }), {
        status: 404, headers,
      });
    }

    // Redacted projection — safe to show to anyone holding the ID
    const safe = {
      id: reg.id,
      status,
      circuit: reg.circuit,
      division: reg.division,
      divisionLabel: reg.divisionLabel,
      path: reg.path,
      amountPaid: reg.amountPaid || null,
      createdAt: reg.createdAt,
      confirmedAt: reg.confirmedAt || null,
      // Payment terms — no account details, just what was asked for / is owed.
      paymentMethod: reg.paymentMethod || 'card',
      paymentStatus: reg.paymentStatus || null,
      totalPrice: reg.totalPrice || reg.price || null,
      depositAmount: reg.depositAmount != null ? reg.depositAmount : null,
      balanceDue: reg.balanceDue != null ? reg.balanceDue : null,
      balanceDueDate: reg.balanceDueDate || null,
    };

    // Venmo instructions (handle / amount / note) so the success page can
    // repeat them — only while the deposit is still outstanding.
    if (reg.paymentMethod === 'venmo' && reg.venmo && status === 'pending') {
      safe.venmo = {
        handle: reg.venmo.handle,
        url: reg.venmo.url,
        amount: reg.venmo.amount,
        note: reg.venmo.note,
      };
    }

    if (reg.path === 'team' && reg.team) {
      safe.team = {
        name: reg.team.name,
        captain: reg.team.captainName || null,
      };
    } else if (reg.path === 'agent' && reg.agent) {
      safe.agent = {
        name: reg.agent.name,
      };
    }

    return new Response(JSON.stringify({ registration: safe }), {
      status: 200, headers,
    });
  } catch (err) {
    console.error('registration-lookup error:', err);
    return new Response(
      JSON.stringify({ error: 'Lookup failed', detail: err.message }),
      { status: 500, headers }
    );
  }
};

export const config = { path: '/.netlify/functions/registration-lookup' };
