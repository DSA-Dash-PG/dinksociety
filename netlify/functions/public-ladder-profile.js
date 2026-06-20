// netlify/functions/public-ladder-profile.js
// GET /api/public-ladder-profile?id=<playerId>
// The ladder player card (Pickleladder layout) for the in-app popup on the
// Ladders page. Delegates to the shared builder in lib/profile-data.js so the
// ladder popup and the unified League+Ladder card stay in sync. `inLeague` flags
// whether this ladder player also has a league profile (same email).

import { buildLadderProfile } from './lib/profile-data.js';
import { findPlayerByEmail } from './lib/player-auth.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' } });
}

export default async (req) => {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return json({ error: 'id required' }, 400);

  const r = await buildLadderProfile(id);
  if (!r.found) return json({ found: false });

  let inLeague = false;
  if (r.email) { try { inLeague = !!(await findPlayerByEmail(r.email)); } catch { inLeague = false; } }

  return json({ found: true, inLeague, email: r.email, player: r.player });
};

export const config = { path: '/.netlify/functions/public-ladder-profile' };
