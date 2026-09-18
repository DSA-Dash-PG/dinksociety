// netlify/functions/player-team-share.js
// Player Portal → "Your team share". A player sees ONLY their own balance plus
// what they need to pay it (captain's name + Venmo handle). Never another
// player's row, never team totals.
//
//   GET                      → { active:false } | { active:true, share, payTo, ... }
//   POST { action:'claim' }  → "I paid" — flags the captain to check and confirm
//   POST { action:'unclaim' }
//
// Captains and co-captains are players too: they get their own row here like
// anyone else, and see the whole team in the captain portal instead.

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { venmoProfileUrl } from './lib/payment-terms.js';
import { getSplit, saveSplit, loadLedger } from './lib/team-split.js';
import { playerView } from './lib/team-split-math.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

export default async (req) => {
  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  if (!ctx.team || !ctx.playerId) return json({ active: false });

  const split = await getSplit(ctx.team.id);
  if (!split || !split.enabled) return json({ active: false });

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const { ledger } = await loadLedger(ctx.team, { split, useCache: true });
    const mine = playerView(ledger, ctx.playerId);
    if (!mine || mine.self) return json({ error: 'Nothing to record.' }, 400);
    split.claims = split.claims || {};
    if (body.action === 'unclaim') {
      delete split.claims[ctx.playerId];
    } else if (body.action === 'claim') {
      if (mine.balanceCents <= 0) return json({ error: 'You’re all paid up.' }, 400);
      split.claims[ctx.playerId] = { cents: mine.balanceCents, at: new Date().toISOString() };
    } else {
      return json({ error: 'Unknown action.' }, 400);
    }
    await saveSplit(split);
  } else if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const { ledger } = await loadLedger(ctx.team, { split, useCache: true });
  const share = playerView(ledger, ctx.playerId);
  if (!share) return json({ active: false });

  return json({
    active: true,
    teamName: ctx.team.name || null,
    share,
    rateCents: ledger.mode === 'pergame' ? (split.rateCents || 0) : null,
    buyInCents: ledger.mode === 'pergame' ? (split.buyInCents || 0) : 0,
    collect: ledger.mode === 'pergame' ? (split.collect || 'weekly') : null,
    payTo: {
      name: ledger.payeeName || 'your captain',
      venmoHandle: split.venmoHandle || null,
      venmoUrl: split.venmoHandle ? venmoProfileUrl(split.venmoHandle) : null,
    },
  });
};

export const config = { path: '/.netlify/functions/player-team-share' };
