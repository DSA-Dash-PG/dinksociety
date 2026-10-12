// netlify/functions/lib/ladder-dupr-export.js
//
// Turns a finished DUPR-rated ladder night into the CSV that DUPR's club
// "Import Matches via CSV" accepts, so an admin can upload the whole night in
// one go. Used by:
//   - ladder-dupr-cron.js   emails the file to the admins after a night ends
//   - admin-ladder-dupr.js  the "Download DUPR CSV" button on the admin ladder page
//
// The header row is DUPR's current single-match import template, column for
// column. DUPR rejects the file if a required column is missing or renamed,
// so do not reorder or rename anything in DUPR_HEADER.
//
// Every game is one doubles match with one game score. A game is left out
// (and reported in `skipped`) when it has no score, is tied (DUPR requires a
// winner), or any of its four players has no DUPR ID. Players who are not
// verified in the DUPR club are kept in the file and listed in `unverified`,
// so the admin knows which rows DUPR may refuse.

import { getEvent, getSignups } from './ladder.js';
import { getPlay } from './ladder-play.js';
import { getDirectory, applyDirectoryToSignups } from './player-directory.js';
import { getMergeMap, resolve } from './player-merge.js';

export const DUPR_HEADER = [
  'matchType', 'event', 'date',
  'playerA1', 'playerA1DuprId', 'playerA1ExternalId',
  'playerA2', 'playerA2DuprId', 'playerA2ExternalId',
  'playerB1', 'playerB1DuprId', 'playerB1ExternalId',
  'playerB2', 'playerB2DuprId', 'playerB2ExternalId',
  'teamAGame1', 'teamBGame1', 'teamAGame2', 'teamBGame2', 'teamAGame3', 'teamBGame3',
  'teamAGame4', 'teamBGame4', 'teamAGame5', 'teamBGame5',
  'location', 'scoreType',
];

// DUPR's scoreType: SIDEOUT (traditional) or RALLY. Ladders are side-out
// unless the event says otherwise.
export function scoreTypeOf(event) {
  const v = String((event && event.duprScoreType) || '').toUpperCase();
  return v === 'RALLY' ? 'RALLY' : 'SIDEOUT';
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * Pure. Build the DUPR import rows for one night.
 *
 * @param {object} args
 * @param {object} args.event   ladder event ({ name, date, place, duprScoreType? })
 * @param {object} args.play    play record ({ rounds:[{ courts:[{ court, team1, team2, score }] }] })
 * @param {(id:string, name?:string)=>({duprId?:string, name?:string, club?:string}|null)} args.lookup
 *        resolves a play player id to their DUPR details
 * @returns {{ header:string[], rows:any[][], csv:string, games:number, total:number,
 *             skipped:Array<{round:number,court:string,reason:string}>,
 *             missing:string[], unverified:string[] }}
 */
export function buildDuprRows({ event, play, lookup }) {
  const eventName = `Dink Society - ${(event && event.name) || 'Ladder'}`;
  const date = (event && event.date) || (play && play.date) || '';
  const location = (event && (event.place || event.address)) || '';
  const scoreType = scoreTypeOf(event);
  const rows = [];
  const skipped = [];
  const missing = new Map();
  const unverified = new Map();
  let total = 0;

  const rounds = (play && play.rounds) || [];
  rounds.forEach((rd, ri) => {
    const courts = (rd && rd.courts) || [];
    const tC = courts.length;
    // Courts in the play data run bottom-up (court === tC is the top court);
    // label them for humans as Court 1 = top.
    const courtLabel = c => `Court ${tC - (Number(c.court) || 0) + 1}`;
    // Top court first, the same order every other ladder view uses.
    [...courts].sort((a, b) => (b.court || 0) - (a.court || 0)).forEach(c => {
      const players = [...(c.team1 || []), ...(c.team2 || [])];
      if (players.filter(Boolean).length < 4) return; // a bye / empty court, not a game
      total++;
      const sc = c.score;
      if (!sc || sc.t1 == null || sc.t2 == null || sc.t1 === '' || sc.t2 === '') {
        skipped.push({ round: ri + 1, court: courtLabel(c), reason: 'no score' });
        return;
      }
      const a = Number(sc.t1), b = Number(sc.t2);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) {
        skipped.push({ round: ri + 1, court: courtLabel(c), reason: `tied ${a}-${b} (DUPR needs a winner)` });
        return;
      }
      const info = players.map(p => {
        const d = (p && lookup(p.id, p.name)) || {};
        return { name: d.name || (p && p.name) || '', duprId: String(d.duprId || '').trim(), club: d.club || '' };
      });
      const noId = info.filter(x => !x.duprId);
      if (noId.length) {
        noId.forEach(x => missing.set(x.name, true));
        skipped.push({ round: ri + 1, court: courtLabel(c), reason: `no DUPR ID for ${noId.map(x => x.name).join(', ')}` });
        return;
      }
      info.forEach(x => { if (x.club !== 'verified') unverified.set(x.name, x.club || 'not confirmed'); });
      const [a1, a2, b1, b2] = info;
      const rec = {
        matchType: 'D', event: eventName, date,
        playerA1: a1.name, playerA1DuprId: a1.duprId,
        playerA2: a2.name, playerA2DuprId: a2.duprId,
        playerB1: b1.name, playerB1DuprId: b1.duprId,
        playerB2: b2.name, playerB2DuprId: b2.duprId,
        teamAGame1: a, teamBGame1: b,
        location, scoreType,
      };
      rows.push(DUPR_HEADER.map(h => (h in rec ? rec[h] : '')));
    });
  });

  return {
    header: DUPR_HEADER,
    rows,
    csv: toCsv([DUPR_HEADER, ...rows]),
    games: rows.length,
    total,
    skipped,
    missing: [...missing.keys()].filter(Boolean).sort(),
    unverified: [...unverified.entries()].map(([name, club]) => ({ name, club })).sort((x, y) => x.name.localeCompare(y.name)),
  };
}

/**
 * Pure. A lookup from any player id (play id, alias, signup id) to the DUPR
 * details we hold for that person. The play data and the signups can carry
 * different ids for the same human (merged duplicates), so everything is keyed
 * on the canonical id after merges.
 */
export function makeLookup({ signups, directory, merges }) {
  const map = merges || {};
  const dir = directory || {};
  const byCanon = {};
  const put = (id, d) => {
    if (!id) return;
    const k = resolve(map, id);
    const cur = byCanon[k] || {};
    byCanon[k] = {
      duprId: cur.duprId || d.duprId || '',
      name: cur.name || d.name || '',
      // a verification anywhere wins
      club: cur.club === 'verified' ? 'verified' : (d.club === 'verified' ? 'verified' : (cur.club || d.club || '')),
    };
  };
  // 1) this ladder's sign-ups (already overlaid with the directory)
  const s = signups || {};
  [...(s.roster || []), ...(s.waitlist || [])].forEach(p => {
    if (!p) return;
    put(p.playerId, { duprId: p.duprId, name: p.name, club: p.duprClub });
  });
  // 2) the master directory fills anyone not on the sign-up sheet (subs added on the night)
  Object.entries(dir).forEach(([id, o]) => { if (o && o.duprId) put(id, { duprId: o.duprId, name: o.name, club: o.duprClub }); });
  // 3) last resort: a unique exact name match on this ladder's sign-up sheet,
  // for a player scored under an id that was never merged with their sign-up.
  const byName = {};
  [...(s.roster || []), ...(s.waitlist || [])].forEach(p => {
    const k = String((p && p.name) || '').trim().toLowerCase();
    if (!k) return;
    byName[k] = byName[k] === undefined ? resolve(map, p.playerId) : null; // null = ambiguous
  });
  return (id, name) => {
    const hit = byCanon[resolve(map, id)];
    if (hit && hit.duprId) return hit;
    const k = byName[String(name || '').trim().toLowerCase()];
    return (k && byCanon[k]) || hit || null;
  };
}

/** Load everything for one event and build its DUPR export. */
export async function duprExportForEvent(eventId) {
  const event = await getEvent(eventId);
  if (!event) return { ok: false, error: 'Ladder not found.' };
  const play = await getPlay(eventId);
  if (!play || !(play.rounds || []).length) return { ok: false, error: 'This ladder has no games yet.', event };
  const [directory, merges, raw] = await Promise.all([
    getDirectory().catch(() => ({})),
    getMergeMap().catch(() => ({})),
    getSignups(eventId).catch(() => null),
  ]);
  const signups = applyDirectoryToSignups(raw || { roster: [], waitlist: [] }, directory);
  const lookup = makeLookup({ signups, directory, merges });
  const out = buildDuprRows({ event, play, lookup });
  return { ok: true, event, play, ...out };
}

/** File name for the download / attachment. */
export function duprFileName(event) {
  const slug = String((event && event.name) || 'ladder').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'ladder';
  return `dupr-${slug}-${(event && event.date) || 'night'}.csv`;
}
