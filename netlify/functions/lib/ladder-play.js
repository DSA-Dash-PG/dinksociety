// netlify/functions/lib/ladder-play.js
// Storage for a ladder's RUN-NIGHT play data (rounds + scores) — the input the
// scoring engine (lib/ladder-scoring.js) reads. One record per event:
//
//   ladder-play  play/<eventId>.json
//   { eventId, date, rounds:[{courts:[{court,team1,team2,score}]}],
//     currentRound, started, finished, config?, source? }
//
// Kept separate from ladder-signups so the signup flow and the gameplay engine
// don't step on each other. Imported historical nights also live here.

import { getStore } from '@netlify/blobs';

const STORE = 'ladder-play';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

export async function getPlay(eventId) {
  return store().get(`play/${eventId}.json`, { type: 'json' }).catch(() => null);
}

export async function setPlay(eventId, rec) {
  rec.eventId = eventId;
  rec.updatedAt = new Date().toISOString();
  await store().setJSON(`play/${eventId}.json`, rec);
  return rec;
}

export async function listPlay() {
  const s = store();
  const { blobs } = await s.list({ prefix: 'play/' }).catch(() => ({ blobs: [] }));
  return (await Promise.all(blobs.map(b => s.get(b.key, { type: 'json' }).catch(() => null)))).filter(Boolean);
}

/** A play record as the scoring engine's `session` shape: { id, date, rounds }. */
export function toSession(play) {
  return { id: play.eventId, date: play.date || null, rounds: play.rounds || [] };
}

/** Union of every player who appears in the given play records → [{id,name,gender}]. */
export function playersFromPlay(plays) {
  const map = {};
  (plays || []).forEach(p => (p.rounds || []).forEach(r => (r.courts || []).forEach(c => {
    [...(c.team1 || []), ...(c.team2 || [])].filter(Boolean).forEach(pl => {
      if (pl.id && !map[pl.id]) map[pl.id] = { id: pl.id, name: pl.name, gender: pl.gender || 'M' };
    });
  })));
  return Object.values(map);
}
