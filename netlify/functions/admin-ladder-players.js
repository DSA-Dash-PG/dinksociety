// netlify/functions/admin-ladder-players.js
// Admin (or scoring PIN) — global ladder player roster + duplicate merging.
//
//   GET                       → { players:[{id,name,gender,nights,mergedInto}], merges:[{from,to,name}] }
//   POST { action }
//     'merge'   { from, to, name? }   alias player `from` onto canonical `to`
//     'unmerge' { from }              undo a merge

import { verifyAdminSession, unauthResponse } from './lib/auth.js';
import { checkLadderPin } from './lib/ladder-pin.js';
import { listPlay, playersFromPlay } from './lib/ladder-play.js';
import { getMergeMap, setMerge, removeMerge } from './lib/player-merge.js';
import { getDirectory, setPlayerInfo } from './lib/player-directory.js';

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }

export default async (req) => {
  const v = await verifyAdminSession(req);
  if (!v.valid && !checkLadderPin(req)) return unauthResponse('Unauthorized');

  if (req.method === 'GET') {
    const plays = await listPlay();                 // RAW — duplicates intact so they can be merged
    const players = playersFromPlay(plays);
    const nights = {};
    plays.forEach(p => {
      const seen = new Set();
      (p.rounds || []).forEach(r => (r.courts || []).forEach(c => [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean).forEach(pl => seen.add(pl.id))));
      seen.forEach(id => { nights[id] = (nights[id] || 0) + 1; });
    });
    const map = await getMergeMap();
    const dir = await getDirectory();
    const list = players
      .map(p => ({ id: p.id, name: (dir[p.id]?.name) || p.name, gender: (dir[p.id]?.gender) || p.gender, email: dir[p.id]?.email || '', nights: nights[p.id] || 0, mergedInto: map[p.id] ? map[p.id].to : null }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const merges = Object.entries(map).map(([from, val]) => ({ from, to: val.to, name: val.name || null }));
    return json({ players: list, merges });
  }

  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === 'merge') { await setMerge(body.from, body.to, body.name); return json({ ok: true }); }
    if (body.action === 'unmerge') { await removeMerge(body.from); return json({ ok: true }); }
    if (body.action === 'update') { const info = await setPlayerInfo(body.id, { email: body.email, name: body.name, gender: body.gender }); return json({ ok: true, info }); }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    return json({ error: e.message || 'failed' }, 400);
  }
};

export const config = { path: '/.netlify/functions/admin-ladder-players' };
