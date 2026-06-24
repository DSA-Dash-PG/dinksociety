// netlify/functions/admin-badges.js
// Admin control panel for the player badge system.
//
//   GET                       → { config:{ badges:[...] } }
//   GET ?overview=1           → adds { grants: { playerId:[...] } } for the season
//   GET ?playerId=ID          → adds { playerGrants:[...] } for one player
//   POST action=save-config   → { overrides?, custom? }  save registry edits
//   POST action=grant         → { playerIds:[...], award:{kind,scope?,type?,week?,label?,date?} }
//   POST action=revoke        → { playerId, grantId }
//
// Cookie-authed admin only. Season derives from ?circuit (default 'I').

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { circuitCode } from './lib/circuit.js';
import {
  getBadgeConfig, saveBadgeConfig,
  addGrant, removeGrant, listAllGrants, listGrantsForPlayer,
} from './lib/badges-config.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const season = circuitCode(url.searchParams.get('circuit') || 'I');

  const verified = await verifyAdminSession(req);
  if (!verified.valid) return unauthResponse(verified.error);
  const admin = verified.payload;

  if (req.method === 'GET') {
    const config = await getBadgeConfig();
    const out = { season, config };
    if (url.searchParams.get('overview')) out.grants = await listAllGrants(season);
    const pid = url.searchParams.get('playerId');
    if (pid) out.playerGrants = await listGrantsForPlayer(season, pid);
    return json(out);
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

    if (body.action === 'save-config') {
      const config = await saveBadgeConfig({ overrides: body.overrides, custom: body.custom }, admin.email);
      return json({ ok: true, config });
    }

    if (body.action === 'grant') {
      const ids = Array.isArray(body.playerIds) ? body.playerIds : (body.playerId ? [body.playerId] : []);
      const award = body.award || {};
      if (!ids.length) return json({ error: 'playerIds required' }, 400);
      if (!award.kind) return json({ error: 'award.kind required' }, 400);
      const res = await addGrant(season, ids, award, admin.email);
      return json(res);
    }

    if (body.action === 'revoke') {
      if (!body.playerId || !body.grantId) return json({ error: 'playerId and grantId required' }, 400);
      const res = await removeGrant(season, body.playerId, body.grantId);
      return json(res);
    }

    return json({ error: `Unknown action: ${body.action}` }, 400);
  }

  return new Response('Method not allowed', { status: 405 });
};

export const config = { path: '/.netlify/functions/admin-badges' };
