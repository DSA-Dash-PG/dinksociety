// netlify/functions/public-ladder-profile.js
// GET /api/public-ladder-profile?id=<playerId>
// The ladder player card (Pickleladder layout) for the in-app popup on the
// Ladders page. Delegates to the shared builder in lib/profile-data.js so the
// ladder popup and the unified League+Ladder card stay in sync. `inLeague` flags
// whether this ladder player also has a league profile (same email).

import { buildLadderProfile } from './lib/profile-data.js';
import { findPlayerByEmail } from './lib/player-auth.js';
import { etagJson } from './lib/http-cache.js';

// Ladder stats only change on score entry, so this can cache for a while.
// ETag lets repeat opens short-circuit with a 304.
const CACHE = 'public, max-age=120, stale-while-revalidate=300';

export default async (req) => {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return etagJson(req, { error: 'id required' }, { status: 400, cacheControl: 'no-store' });

  const r = await buildLadderProfile(id);
  if (!r.found) return etagJson(req, { found: false }, { cacheControl: CACHE });

  let inLeague = false, photoUrl = null;
  // r.email is used server-side only (to detect a matching league profile);
  // it is intentionally NOT returned to the client. When the player also has a
  // league profile, pass through their photo URL so the ladder card can show it
  // (player-photo-serve 404s if they have no photo → client falls back to initials).
  if (r.email) {
    try {
      const lp = await findPlayerByEmail(r.email);
      if (lp) {
        inLeague = true;
        if (lp.playerId) photoUrl = '/.netlify/functions/player-photo-serve?id=' + encodeURIComponent(lp.playerId);
      }
    } catch { inLeague = false; }
  }

  return etagJson(req, { found: true, inLeague, photoUrl, player: r.player }, { cacheControl: CACHE });
};

export const config = { path: '/.netlify/functions/public-ladder-profile' };
