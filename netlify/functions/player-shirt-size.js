// netlify/functions/player-shirt-size.js
// A player's own shirt size, set from their profile in the Player Portal.
//
//   GET                   → { size, cut, sizes, cuts }
//   POST { size, cut? }   → saves right away (no approval — it isn't public
//                           bio content, it's what the league orders for them)
//
// Works for league players and ladder-only ("lite") players alike. Stored per
// person (by email) so it carries across seasons — see lib/shirt-sizes.js.

import { verifyPlayerSession, unauthResponse } from './lib/auth.js';
import { SIZES, CUTS, cleanSize, cleanCut, getAllSizes, lookupSize, setSize } from './lib/shirt-sizes.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });
}

export default async (req) => {
  const verified = await verifyPlayerSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const ctx = verified.payload;
  const who = { email: ctx.session.email || ctx.player?.email || null, playerId: ctx.playerId };

  if (req.method === 'GET') {
    const rec = lookupSize(await getAllSizes(), who);
    return json({ size: rec?.size || null, cut: rec?.cut || null, sizes: SIZES, cuts: CUTS });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const body = await req.json().catch(() => ({}));
  const size = cleanSize(body.size);
  if (!size) return json({ error: 'Pick a size.' }, 400);
  const cut = body.cut == null ? null : cleanCut(body.cut);
  if (body.cut != null && !cut) return json({ error: 'Pick a cut.' }, 400);
  const rec = await setSize(who, { size, cut }, 'player');
  return json({ ok: true, size: rec.size, cut: rec.cut, sizes: SIZES, cuts: CUTS });
};

export const config = { path: '/.netlify/functions/player-shirt-size' };
