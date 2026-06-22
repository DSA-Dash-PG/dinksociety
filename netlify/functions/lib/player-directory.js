// netlify/functions/lib/player-directory.js
//
// A master directory of ladder-player details keyed by playerId — the single
// place to set a player's email (which links their ladder profile to their league
// profile), and to correct their display name / gender across every ladder at once.
// Email lived only on per-event signups before; this lets an admin set it once.
//
//   ladder-players  directory.json → { [playerId]: { email, name, gender } }

import { getStore } from '@netlify/blobs';

const STORE = 'ladder-players';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }

export async function getDirectory() {
  const d = await store().get('directory.json', { type: 'json' }).catch(() => null);
  return (d && typeof d === 'object') ? d : {};
}

export async function setPlayerInfo(id, info = {}) {
  if (!id) throw new Error('id required');
  const dir = await getDirectory();
  const next = { ...(dir[id] || {}) };
  if ('email' in info) next.email = String(info.email || '').trim().toLowerCase();
  if ('name' in info && info.name) next.name = String(info.name).trim().slice(0, 60);
  if ('gender' in info && info.gender) next.gender = info.gender === 'F' ? 'F' : 'M';
  dir[id] = next;
  await store().setJSON('directory.json', dir);
  return next;
}

// Overlay live directory name/gender onto a signups record's roster/waitlist/claim
// (keyed by playerId), so editing a player in the directory updates every ladder.
export function applyDirectoryToSignups(rec, dir) {
  if (!rec || !dir || !Object.keys(dir).length) return rec;
  const fix = p => { if (!p) return; const o = dir[p.playerId]; if (o) { if (o.name) p.name = o.name; if (o.gender) p.gender = o.gender; } };
  (rec.roster || []).forEach(fix);
  (rec.waitlist || []).forEach(fix);
  fix(rec.pendingClaim);
  return rec;
}

// Override display name/gender on play records from the directory (run AFTER merges
// so the keys are canonical ids).
export function applyDirectory(plays, dir) {
  if (!dir || !Object.keys(dir).length) return plays;
  (plays || []).forEach(play => (play.rounds || []).forEach(rd => (rd.courts || []).forEach(c =>
    ['team1', 'team2'].forEach(tk => (c[tk] || []).forEach(p => {
      if (!p) return; const o = dir[p.id]; if (o) { if (o.name) p.name = o.name; if (o.gender) p.gender = o.gender; }
    })))));
  return plays;
}
