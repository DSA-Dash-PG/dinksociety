// netlify/functions/public-profile.js
// GET /api/public-profile?ladderId=X | ?leagueId=Y | ?email=Z [&circuit=I]
//
// The UNIFIED player profile: one person across both products. Resolves a
// canonical email from whichever id was passed, then assembles the League side
// (DSR + record) and the Ladder side (DR + full card) so the shared profile page
// can show both lanes. Either side may be absent (ladder-only or league-only).

import { buildUnifiedProfile } from './lib/profile-data.js';
import { etagJson } from './lib/http-cache.js';

const CACHE = 'public, max-age=120, stale-while-revalidate=300';

export default async (req) => {
  const u = new URL(req.url).searchParams;
  const email = u.get('email'), ladderId = u.get('ladderId'), leagueId = u.get('leagueId');
  const circuit = (u.get('circuit') || 'I').trim();
  if (!email && !ladderId && !leagueId) return etagJson(req, { error: 'email, ladderId, or leagueId required' }, { status: 400, cacheControl: 'no-store' });

  try {
    const out = await buildUnifiedProfile({ email, ladderId, leagueId, circuit });
    return etagJson(req, out, { cacheControl: CACHE });
  } catch (err) {
    console.error('public-profile error:', err);
    return etagJson(req, { error: 'Profile unavailable' }, { status: 500, cacheControl: 'no-store' });
  }
};

export const config = { path: '/.netlify/functions/public-profile' };
