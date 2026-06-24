// netlify/functions/public-badges.js
// Public read for the badge system, used by every profile surface.
//
//   GET ?circuit=I              → { season, config:{ badges:[...] } }
//   GET ?circuit=I&playerId=ID  → adds { grants:[...] } (manual awards for that player)
//
// The config carries labels / colors / enabled / custom-logo URLs so the client
// renders exactly what the admin configured. Auto-derived badges (POTW, ladder,
// streaks, undefeated) are computed client-side from data the surface already has.
// Public + cached; no auth.

import { circuitCode } from './lib/circuit.js';
import { getBadgeConfig, listGrantsForPlayer } from './lib/badges-config.js';

const LOGO_BASE = '/.netlify/functions/site-images-serve?id=';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=600',
    },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const season = circuitCode(url.searchParams.get('circuit') || 'I');

  try {
    const cfg = await getBadgeConfig();
    // Expose only what the client needs, and resolve logo ids to URLs.
    const badges = (cfg.badges || []).map((b) => ({
      kind: b.kind, label: b.label, tone: b.tone, pri: b.pri, enabled: b.enabled !== false,
      logoUrl: b.logoId ? (LOGO_BASE + b.logoId) : null,
    }));

    const out = { season, config: { badges } };
    const pid = url.searchParams.get('playerId');
    if (pid) out.grants = await listGrantsForPlayer(season, pid);
    return json(out);
  } catch (e) {
    console.error('public-badges error:', e);
    return json({ season, config: { badges: [] }, grants: [] });
  }
};

export const config = { path: '/.netlify/functions/public-badges' };
