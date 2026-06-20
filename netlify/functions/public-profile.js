// netlify/functions/public-profile.js
// GET /api/public-profile?ladderId=X | ?leagueId=Y | ?email=Z [&circuit=I]
//
// The UNIFIED player profile: one person across both products. Resolves a
// canonical email from whichever id was passed, then assembles the League side
// (DSR + record) and the Ladder side (DR + full card) so the shared profile page
// can show both lanes. Either side may be absent (ladder-only or league-only).

import { buildUnifiedProfile } from './lib/profile-data.js';

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' } });
}

export default async (req) => {
  const u = new URL(req.url).searchParams;
  const email = u.get('email'), ladderId = u.get('ladderId'), leagueId = u.get('leagueId');
  const circuit = (u.get('circuit') || 'I').trim();
  if (!email && !ladderId && !leagueId) return json({ error: 'email, ladderId, or leagueId required' }, 400);

  try {
    const out = await buildUnifiedProfile({ email, ladderId, leagueId, circuit });
    return json(out);
  } catch (err) {
    console.error('public-profile error:', err);
    return json({ error: 'Profile unavailable' }, 500);
  }
};

export const config = { path: '/.netlify/functions/public-profile' };
