// netlify/functions/public-ladder-teams.js
// GET /api/public-ladder-teams?ids=<ladderId>,<ladderId>,…[&circuit=II]
//   → { circuit: "II",
//       teams: { <ladderId>: { name, circuit, season, current } } }
//
// Which league team (if any) each LADDER player is on, in one call. Powers the
// team chip on the Ladder tab of leaderboard.html.
//
// Why this exists: the Ladder tab used to guess the chip on the client by
// comparing the ladder display name to the roster name in the selected
// season's player-stats blob. "Ryan H" never equals "Ryan Hxxxx", a Season 1
// player with no Season 2 roster entry yet fell through, and everyone who
// missed the string match was labelled "Free agent". This resolves by
// IDENTITY instead — the same chain public-ladder-avatars uses:
//
//   1. The ladder id IS a league roster id (a player who registered herself
//      with her roster id) → direct hit, plus her email → every other season.
//   2. Otherwise the ladder id is a lite `lp_…` account or a manual roster add
//      (synthetic id) → find her email (lite record, master directory) → every
//      roster entry with that email across every season.
//
// Pick: a non-archived stint in the requested circuit wins (`current: true`);
// else the most recent non-archived stint anywhere (`current: false`, the
// client tags it with its season); else nothing — a real free agent.
//
// Public, no auth, no emails in the response. Rosters change rarely, so this
// caches for a while.

import { loadAllTeams, seasonOrder } from './lib/league-players.js';
import { getDirectory } from './lib/player-directory.js';
import { getLiteById, isLiteId } from './lib/ladder-players.js';
import { normalizeEmail } from './lib/identity.js';
import { circuitCode, seasonName } from './lib/circuit.js';
import { etagJson } from './lib/http-cache.js';

const CACHE = 'public, max-age=300, stale-while-revalidate=3600';
const VALID_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_IDS = 300;

/**
 * Every roster stint across every real season, indexed two ways:
 *   byId    Map<rosterId, stint>      (one entry per roster row)
 *   byEmail Map<normalizedEmail, stint[]>
 * pendingAdd rows are requests, not members — skipped (same rule as
 * league-players.js). Archived rows are kept but flagged so they only win
 * when nothing better exists.
 */
async function indexStints() {
  const byId = new Map();
  const byEmail = new Map();
  const teams = await loadAllTeams().catch(() => []);
  for (const team of teams) {
    const raw = team.circuit || team.seasonId;
    const stint = {
      teamId: team.id || null,
      name: team.name || '',
      circuit: circuitCode(raw),
      season: seasonName(raw),
      order: seasonOrder(raw),
    };
    for (const p of team.roster || []) {
      if (!p || p.pendingAdd) continue;
      const s = { ...stint, archived: !!p.archived };
      if (p.id && !byId.has(p.id)) byId.set(p.id, s);
      const norm = p.normalizedEmail || normalizeEmail(p.email);
      if (norm) {
        if (!byEmail.has(norm)) byEmail.set(norm, []);
        byEmail.get(norm).push(s);
      }
    }
  }
  return { byId, byEmail };
}

/** Best stint for the chip, or null. */
function pick(stints, wantCode) {
  if (!stints.length) return null;
  const live = stints.filter(s => !s.archived);
  const inSeason = live.find(s => s.circuit === wantCode);
  if (inSeason) return { ...inSeason, current: true };
  const pool = live.length ? live : stints;
  const latest = pool.reduce((best, s) => (s.order > best.order ? s : best));
  return { ...latest, current: latest.circuit === wantCode };
}

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const raw = params.get('ids') || '';
  const ids = [...new Set(raw.split(',').map(s => s.trim()).filter(id => VALID_ID.test(id)))].slice(0, MAX_IDS);
  const wantCode = circuitCode(params.get('circuit') || 'I');
  if (!ids.length) return etagJson(req, { circuit: wantCode, teams: {} }, { cacheControl: CACHE });

  const [{ byId, byEmail }, dir] = await Promise.all([
    indexStints(),
    getDirectory().catch(() => ({})),
  ]);

  const out = {};
  await Promise.all(ids.map(async id => {
    const stints = [];
    const emails = new Set();

    // 1. Ladder id is a roster id.
    const direct = byId.get(id);
    if (direct) stints.push(direct);

    // 2. Emails that identify this ladder player.
    const dirEmail = normalizeEmail(dir[id]?.email);
    if (dirEmail) emails.add(dirEmail);
    if (isLiteId(id)) {
      const lite = await getLiteById(id).catch(() => null);
      const norm = normalizeEmail(lite?.normalizedEmail || lite?.email);
      if (norm) emails.add(norm);
    }
    for (const e of emails) for (const s of byEmail.get(e) || []) stints.push(s);

    // De-dupe by team (a direct hit is also in the email list).
    const seen = new Set();
    const uniq = stints.filter(s => { const k = s.teamId || s.name; if (seen.has(k)) return false; seen.add(k); return true; });

    const best = pick(uniq, wantCode);
    if (best) out[id] = { name: best.name, circuit: best.circuit, season: best.season, current: best.current };
  }));

  return etagJson(req, { circuit: wantCode, teams: out }, { cacheControl: CACHE });
};

export const config = { path: '/.netlify/functions/public-ladder-teams' };
