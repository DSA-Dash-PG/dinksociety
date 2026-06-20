// netlify/functions/admin-ladder-xp.js
// Admin (or scoring PIN) — manage XP rules and awards.
//
//   GET                          → { amounts, awards, grants, players }
//   POST { action, ... }
//     'save-amounts'  { amounts }            edit built-in rule values
//     'upsert-award'  { id?, label, xp }     add/update a custom award type
//     'remove-award'  { id }                 delete a custom award type
//     'grant'         { playerId, label, xp, awardId? }   give XP to a player
//     'ungrant'       { id }                 remove a manual grant

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { checkLadderPin } from './lib/ladder-pin.js';
import { listPlay, playersFromPlay } from './lib/ladder-play.js';
import { getXpConfig, setXpConfig, upsertAward, removeAward, getXpGrants, addXpGrant, removeXpGrant } from './lib/xp-config.js';
import { getMergeMap, applyMerges } from './lib/player-merge.js';
import { getDirectory, applyDirectory } from './lib/player-directory.js';

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid && !checkLadderPin(req)) return unauthResponse('Unauthorized');

  if (req.method === 'GET') {
    const cfg = await getXpConfig();
    const grants = await getXpGrants();
    const players = playersFromPlay(applyDirectory(applyMerges(await listPlay(), await getMergeMap()), await getDirectory()))
      .map(p => ({ id: p.id, name: p.name, gender: p.gender }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return json({ amounts: cfg.amounts, awards: cfg.awards, grants, players });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.json().catch(() => ({}));

  try {
    switch (body.action) {
      case 'save-amounts': {
        const cfg = await setXpConfig({ amounts: body.amounts || {} });
        return json({ ok: true, amounts: cfg.amounts });
      }
      case 'upsert-award': {
        const awards = await upsertAward({ id: body.id, label: body.label, xp: body.xp });
        return json({ ok: true, awards });
      }
      case 'remove-award': {
        await removeAward(body.id);
        return json({ ok: true });
      }
      case 'grant': {
        const entry = await addXpGrant({ playerId: body.playerId, label: body.label, xp: body.xp, awardId: body.awardId });
        return json({ ok: true, grant: entry });
      }
      case 'ungrant': {
        await removeXpGrant(body.id);
        return json({ ok: true });
      }
      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    return json({ error: e.message || 'failed' }, 400);
  }
};

export const config = { path: '/.netlify/functions/admin-ladder-xp' };
