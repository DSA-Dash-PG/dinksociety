// netlify/functions/admin-ladder-players.js
// Admin (or scoring PIN) — global ladder player roster + duplicate merging.
//
//   GET                       → { players:[{id,name,gender,nights,mergedInto}], merges:[{from,to,name}] }
//   POST { action }
//     'merge'   { from, to, name? }   alias player `from` onto canonical `to`
//     'unmerge' { from }              undo a merge

import { unauthResponse } from './lib/auth.js';
import { authScoreAccess } from './lib/ladder-scorer.js';
import { listPlay, playersFromPlay } from './lib/ladder-play.js';
import { getMergeMap, setMerge, removeMerge } from './lib/player-merge.js';
import { getDirectory, setPlayerInfo } from './lib/player-directory.js';
import { listEvents, getSignups } from './lib/ladder.js';

function json(b, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }); }

export default async (req) => {
  const auth = await authScoreAccess(req, null); // event-agnostic read for roster search
  if (!auth.ok) return unauthResponse('Unauthorized');
  // Scorers and organizers get READ access to the master roster (to add players
  // without minting duplicates), but only admins may merge/rename globally.
  if ((auth.scorer || auth.organizer) && req.method !== 'GET') return unauthResponse('Read-only access here.');

  if (req.method === 'GET') {
    const plays = await listPlay();                 // RAW — duplicates intact so they can be merged
    const playPlayers = playersFromPlay(plays);     // [{id,name,gender}] from SCORED rounds

    // Count the distinct ladders each player belongs to — from scored play AND
    // from current rosters/waitlists, so a player shows up the moment they're
    // added to a roster, not only once their night has been scored.
    const ladderIds = {};                           // playerId -> Set(eventId)
    const addEvt = (id, evId) => { if (!id) return; (ladderIds[id] = ladderIds[id] || new Set()).add(evId); };
    plays.forEach(p => {
      const seen = new Set();
      (p.rounds || []).forEach(r => (r.courts || []).forEach(c => [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean).forEach(pl => seen.add(pl.id))));
      seen.forEach(id => addEvt(id, p.eventId));
    });

    // Pull players off every ladder's roster + waitlist (each entry has a stable
    // playerId — a linked lp_/team id, or a manual_ id for no-email adds).
    const rosterPlayers = {};                        // id -> {id,name,gender}
    const events = await listEvents().catch(() => []);
    await Promise.all(events.map(async (ev) => {
      const sg = await getSignups(ev.id).catch(() => null);
      if (!sg) return;
      [...(sg.roster || []), ...(sg.waitlist || [])].forEach((pl) => {
        if (!pl || !pl.playerId) return;
        addEvt(pl.playerId, ev.id);
        if (!rosterPlayers[pl.playerId]) rosterPlayers[pl.playerId] = { id: pl.playerId, name: pl.name, gender: pl.gender || 'M' };
      });
    }));

    // Union of scored-play players and roster players.
    const universe = {};
    playPlayers.forEach(p => { universe[p.id] = { id: p.id, name: p.name, gender: p.gender }; });
    Object.values(rosterPlayers).forEach(p => { if (!universe[p.id]) universe[p.id] = p; });

    const map = await getMergeMap();
    const dir = await getDirectory();
    const list = Object.values(universe)
      .map(p => ({ id: p.id, name: (dir[p.id]?.name) || p.name, gender: (dir[p.id]?.gender) || p.gender, email: dir[p.id]?.email || '', nights: ladderIds[p.id] ? ladderIds[p.id].size : 0, mergedInto: map[p.id] ? map[p.id].to : null }))
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
