// netlify/functions/captain-split.js
// Captain portal → Billing → "Split with your team".
// The captain (or a co-captain) works out what each player owes the captain for
// the team fee and keeps the ledger. NO money moves through the app — players
// pay the captain on Venmo (or however) and the captain records it here.
//
//   GET                       → { config, ledger, rosterLocked, teamFeeCents }
//   POST { action, ... }
//     save           { enabled?, mode, amount?, rate?, buyIn?, collect?, venmoHandle? }
//     override       { playerId, amount | null }      flat: pin / unpin one share
//     lock | unlock                                    flat: freeze / thaw the player set
//     pay            { playerId, amount? , method?, note? }   amount omitted = full balance
//     undo-pay       { playerId, paymentId }
//     confirm-claim  { playerId }     player tapped "I paid" → record it
//     dismiss-claim  { playerId }
//
// Visibility: captain + co-captains see the whole team (both pass
// verifyCaptainSession). Players only ever get their own row — see
// player-team-share.js.

import { getStore } from '@netlify/blobs';
import { verifyCaptainSession, unauthResponse } from './lib/auth.js';
import { findRegistration, owedTotal } from './lib/registrations.js';
import { logActivity } from './lib/activity-log.js';
import { getSplit, saveSplit, newSplit, loadLedger, publicConfig } from './lib/team-split.js';
import { toCents, fmtCents, normalizeHandle, MAX_AMOUNT_CENTS, MAX_RATE_CENTS, PAY_METHODS } from './lib/team-split-math.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}
function payId() {
  const b = new Uint8Array(5); crypto.getRandomValues(b);
  return 'tp_' + Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function teamFeeCents(team) {
  try {
    if (!team.registrationId) return null;
    const found = await findRegistration(getStore('registrations'), team.registrationId);
    const reg = found?.reg;
    const total = owedTotal(reg); // the fee this team actually owes — league or promo discount included
    return total > 0 ? Math.round(total * 100) : null;
  } catch { return null; }
}

const activeCount = (team) => (team.roster || []).filter(p => p && p.id && !p.archived && !p.pendingAdd).length;

async function respond(team, split) {
  const { ledger, rosterLocked } = await loadLedger(team, { split });
  return json({ ok: true, config: publicConfig(split), ledger, rosterLocked, teamFeeCents: await teamFeeCents(team), activeCount: activeCount(team) });
}

export default async (req) => {
  const verified = await verifyCaptainSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const team = ctx.team;
  const actor = { email: ctx.user.email, role: ctx.user.role };

  if (req.method === 'GET') {
    const split = await getSplit(team.id);
    if (!split) return json({ ok: true, config: null, ledger: null, rosterLocked: false, teamFeeCents: await teamFeeCents(team), activeCount: activeCount(team) });
    return respond(team, split);
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '');
  let split = await getSplit(team.id);

  if (action === 'save') {
    split = split || newSplit(team.id);
    const mode = body.mode === 'pergame' ? 'pergame' : 'flat';
    if (mode === 'flat') {
      const c = toCents(body.amount);
      if (c == null || c > MAX_AMOUNT_CENTS) return json({ error: 'Enter the amount to split, like 700 or 712.50.' }, 400);
      split.amountCents = c;
    } else {
      const c = toCents(body.rate);
      if (c == null || c > MAX_RATE_CENTS) return json({ error: 'Enter a price per game, like 4.25.' }, 400);
      split.rateCents = c;
      // Optional flat buy-in that the per-game charges draw down. Blank / 0 = none.
      const b = body.buyIn == null || String(body.buyIn).trim() === '' ? 0 : toCents(body.buyIn);
      if (b == null || b > MAX_AMOUNT_CENTS) return json({ error: 'Enter the buy-in like 50 — or leave it blank for none.' }, 400);
      split.buyInCents = b;
      split.collect = body.collect === 'season' ? 'season' : 'weekly';
    }
    if (body.venmoHandle != null && String(body.venmoHandle).trim() !== '') {
      const hdl = normalizeHandle(body.venmoHandle);
      if (!hdl) return json({ error: 'That Venmo handle doesn’t look right — letters, numbers, dashes and underscores only.' }, 400);
      split.venmoHandle = hdl;
    } else if (body.venmoHandle === '') {
      split.venmoHandle = null;
    }
    split.mode = mode;
    split.enabled = body.enabled === false ? false : true;
    await saveSplit(split, actor.email);
    await logActivity({
      type: 'split.saved', actor, team,
      details: `${team.name}: team split ${split.enabled ? 'set to' : 'turned off —'} ${mode === 'flat' ? 'flat ' + fmtCents(split.amountCents) : fmtCents(split.rateCents) + ' per game' + (split.buyInCents ? ' with a ' + fmtCents(split.buyInCents) + ' buy-in' : '')}`,
    }).catch(() => {});
    return respond(team, split);
  }

  if (!split) return json({ error: 'Set up the split first.' }, 400);
  const roster = team.roster || [];
  const player = body.playerId ? roster.find(p => p && p.id === body.playerId) : null;

  if (action === 'override') {
    if (!player) return json({ error: 'Player not found on this team.' }, 404);
    split.overrides = split.overrides || {};
    if (body.amount == null || body.amount === '') delete split.overrides[player.id];
    else {
      const c = toCents(body.amount);
      if (c == null || c > MAX_AMOUNT_CENTS) return json({ error: 'Enter an amount like 35 or 35.50 — or leave it blank to go back to an even share.' }, 400);
      split.overrides[player.id] = c;
    }
    await saveSplit(split, actor.email);
    return respond(team, split);
  }

  if (action === 'lock') {
    split.lockedPlayerIds = roster.filter(p => p && p.id && !p.archived && !p.pendingAdd).map(p => p.id);
    split.lockedAt = new Date().toISOString();
    split.lockedBy = actor.email;
    await saveSplit(split, actor.email);
    return respond(team, split);
  }
  if (action === 'unlock') {
    // If the ROSTER is locked, the next read freezes the set again (from the
    // roster as it stands now) — which is exactly a "re-sync to my roster".
    split.lockedPlayerIds = null; split.lockedAt = null; split.lockedBy = null;
    await saveSplit(split, actor.email);
    return respond(team, split);
  }

  if (action === 'pay' || action === 'confirm-claim') {
    if (!player) return json({ error: 'Player not found on this team.' }, 404);
    const { ledger } = await loadLedger(team, { split });
    const row = ledger.rows.find(r => r.playerId === player.id);
    if (!row || row.self) return json({ error: 'Nothing to record for that player.' }, 400);
    let cents;
    if (action === 'confirm-claim') {
      const claim = split.claims?.[player.id];
      if (!claim) return json({ error: 'That claim was already handled.' }, 409);
      cents = claim.cents;
    } else if (body.amount == null || body.amount === '') {
      cents = row.balanceCents;
    } else {
      cents = toCents(body.amount);
    }
    if (!Number.isInteger(cents) || cents <= 0 || cents > MAX_AMOUNT_CENTS) return json({ error: 'Enter how much they paid, like 70 or 8.50.' }, 400);
    const method = PAY_METHODS.includes(body.method) ? body.method : (action === 'confirm-claim' ? 'venmo' : 'other');
    split.payments = split.payments || {};
    (split.payments[player.id] = split.payments[player.id] || []).push({
      id: payId(), cents, at: new Date().toISOString(), by: actor.email, method,
      note: body.note ? String(body.note).slice(0, 120) : null,
    });
    if (split.claims) delete split.claims[player.id];
    await saveSplit(split, actor.email);
    return respond(team, split);
  }

  if (action === 'undo-pay') {
    if (!player) return json({ error: 'Player not found on this team.' }, 404);
    const list = split.payments?.[player.id] || [];
    const i = list.findIndex(p => p.id === body.paymentId);
    if (i < 0) return json({ error: 'Payment not found.' }, 404);
    list.splice(i, 1);
    if (!list.length) delete split.payments[player.id];
    await saveSplit(split, actor.email);
    return respond(team, split);
  }

  if (action === 'dismiss-claim') {
    if (!player) return json({ error: 'Player not found on this team.' }, 404);
    if (split.claims) delete split.claims[player.id];
    await saveSplit(split, actor.email);
    return respond(team, split);
  }

  return json({ error: 'Unknown action.' }, 400);
};

export const config = { path: '/.netlify/functions/captain-split' };
