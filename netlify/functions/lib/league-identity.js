// netlify/functions/lib/league-identity.js
//
// ONE PERSON, MANY ROSTER ENTRIES.
//
// A league "player" is a roster entry embedded in team/<id>.json, and every
// registration mints a fresh entry id (`p_<regId>_<i>`). So the same human
// rostered on a new team next season — or captaining her own team — lands a
// brand-new id, and her stats, history, profile and photo stay behind on the
// old entry.
//
// This module is the read-time fix: it groups roster entries into PEOPLE.
//
//   Rule: the same normalized email is the same person.
//
// Contact info is not proof — a couple can share one inbox — so admins can
// override in both directions from the Players tab:
//
//   • "Not the same person"  → a split: those two ids never auto-join.
//   • "Same person"          → a link: two ids join even with different emails
//                              (married name, typo'd address, a second inbox).
//
// Storage: the `league-identity` blob, key `map.json`:
//   { links:  { "<fromId>": { "to": "<toId>", "note": "..." } },
//     splits: { "<idA>|<idB>": true } }        // pair key is sorted
//
// NOTHING IS REWRITTEN. Roster ids, player-stats keys and player-history keys
// stay exactly as they are; the grouping is applied when a profile is read. A
// bad link is undone by deleting one map entry, never by a data migration.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';
import { circuitCode } from './circuit.js';

const STORE = 'league-identity';
const MAP_KEY = 'map.json';

function store() { return getStore({ name: STORE, consistency: 'strong' }); }

/** Sorted, order-independent key for a pair of ids. */
export function pairKey(a, b) { return [String(a), String(b)].sort().join('|'); }

const EMPTY_MAP = { links: {}, splits: {} };

export async function getIdentityMap() {
  const m = await store().get(MAP_KEY, { type: 'json' }).catch(() => null);
  if (!m || typeof m !== 'object') return { ...EMPTY_MAP };
  return { links: m.links || {}, splits: m.splits || {} };
}

async function saveIdentityMap(map) {
  await store().setJSON(MAP_KEY, { links: map.links || {}, splits: map.splits || {} });
  return map;
}

/** Force two ids to be the same person (different emails, married name, typo). */
export async function setLink(fromId, toId, note) {
  if (!fromId || !toId || fromId === toId) throw new Error('invalid link');
  const map = await getIdentityMap();
  // Don't let a chain loop back on itself.
  if (resolveLink(map.links, toId) === fromId) throw new Error('would create a loop');
  map.links[fromId] = { to: toId, note: note || null };
  // A forced link beats a previous split of the same pair.
  delete map.splits[pairKey(fromId, toId)];
  return saveIdentityMap(map);
}

export async function removeLink(fromId) {
  const map = await getIdentityMap();
  delete map.links[fromId];
  return saveIdentityMap(map);
}

/** Mark two ids as different people despite the shared contact info. */
export async function setSeparate(idA, idB) {
  if (!idA || !idB || idA === idB) throw new Error('invalid split');
  const map = await getIdentityMap();
  map.splits[pairKey(idA, idB)] = true;
  // A split beats a previous forced link in either direction.
  if (map.links[idA]?.to === idB) delete map.links[idA];
  if (map.links[idB]?.to === idA) delete map.links[idB];
  return saveIdentityMap(map);
}

export async function removeSeparate(idA, idB) {
  const map = await getIdentityMap();
  delete map.splits[pairKey(idA, idB)];
  return saveIdentityMap(map);
}

/** Follow a link chain to its end (cycle-guarded). */
export function resolveLink(links, id) {
  let cur = id; const seen = new Set();
  while (links?.[cur]?.to && !seen.has(cur)) { seen.add(cur); cur = links[cur].to; }
  return cur;
}

// ── Grouping ────────────────────────────────────────────────────────────────
// Pure so it can be unit-tested without touching Blobs.

/**
 * Group roster entries into people.
 * @param {{id:string,email?:string,normalizedEmail?:string,seasonId?:string,circuit?:string,teamId?:string,name?:string}[]} entries
 * @param {{links?:object,splits?:object}} map admin overrides
 * @returns {{ canonicalOf: Object<string,string>, membersOf: Object<string,string[]> }}
 *   canonicalOf: every id → its person id.  membersOf: person id → all its ids.
 */
export function groupEntries(entries, map = EMPTY_MAP) {
  const links = map.links || {};
  const splits = map.splits || {};

  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const list = (entries || []).filter(e => e && e.id);
  for (const e of list) if (!parent.has(e.id)) parent.set(e.id, e.id);

  // 1) Same normalized email → same person, unless the pair is split.
  //    Groups are tiny (2–4 entries), so the pairwise pass is free and lets a
  //    single split peel one person out of a shared inbox.
  const byEmail = new Map();
  for (const e of list) {
    const em = e.normalizedEmail || normalizeEmail(e.email);
    if (!em) continue;
    if (!byEmail.has(em)) byEmail.set(em, []);
    byEmail.get(em).push(e.id);
  }
  for (const ids of byEmail.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (splits[pairKey(ids[i], ids[j])]) continue;
        union(ids[i], ids[j]);
      }
    }
  }

  // 2) Admin links win outright — they exist precisely for the cases email misses.
  for (const from of Object.keys(links)) {
    const to = resolveLink(links, from);
    if (!to || to === from) continue;
    if (!parent.has(from)) parent.set(from, from);
    if (!parent.has(to)) parent.set(to, to);
    union(from, to);
  }

  // 3) Collect members, then name each group after its most recent entry so a
  //    profile reads with the person's current team rather than an old one.
  const byRoot = new Map();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(id);
  }
  const entryById = new Map(list.map(e => [e.id, e]));
  const canonicalOf = {}; const membersOf = {};
  for (const ids of byRoot.values()) {
    ids.sort();
    const canon = ids.slice().sort((a, b) => {
      const ea = entryById.get(a) || {}, eb = entryById.get(b) || {};
      const d = seasonRank(eb) - seasonRank(ea);       // newest season first
      return d !== 0 ? d : String(a).localeCompare(String(b));
    })[0];
    membersOf[canon] = ids;
    for (const id of ids) canonicalOf[id] = canon;
  }
  return { canonicalOf, membersOf };
}

const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];
function seasonRank(entry) {
  const code = circuitCode(entry.circuit || entry.seasonId || '');
  const i = ROMAN.indexOf(code);
  return i >= 0 ? i : -1; // TEST / unknown sort last
}

// ── Blob-backed helpers ─────────────────────────────────────────────────────

/** Every roster entry across every team, flattened. */
export async function listRosterEntries() {
  const teams = getStore('teams');
  const { blobs } = await teams.list({ prefix: 'team/' }).catch(() => ({ blobs: [] }));
  const loaded = await Promise.all(blobs.map(b => teams.get(b.key, { type: 'json' }).catch(() => null)));
  const out = [];
  for (const team of loaded) {
    for (const p of team?.roster || []) {
      if (!p?.id) continue;
      out.push({
        id: p.id,
        name: p.name || null,
        email: p.email || null,
        normalizedEmail: p.normalizedEmail || normalizeEmail(p.email),
        phone: p.phone || null,
        teamId: team.id,
        teamName: team.name || null,
        seasonId: team.seasonId || null,
        circuit: team.circuit || null,
      });
    }
  }
  return out;
}

/**
 * Every roster id belonging to the same person as `playerId`.
 * Always includes `playerId` itself, so callers can use it unconditionally.
 * Falls back to just `[playerId]` if anything goes wrong — a profile that
 * shows one season is far better than a profile that 500s.
 */
export async function identityIdsFor(playerId) {
  if (!playerId) return [];
  try {
    const [entries, map] = await Promise.all([listRosterEntries(), getIdentityMap()]);
    const { canonicalOf, membersOf } = groupEntries(entries, map);
    const canon = canonicalOf[playerId];
    const ids = canon ? (membersOf[canon] || []) : [];
    return ids.includes(playerId) ? ids : [playerId, ...ids];
  } catch (err) {
    console.error('identityIdsFor failed; falling back to the single id:', err.message);
    return [playerId];
  }
}

// ── Stats merging ───────────────────────────────────────────────────────────

/**
 * Combine one person's player-stats rows (she can hold more than one id in the
 * same season if she plays for two teams).
 *
 * Counting stats add up. DSR (`composite`) is a RATING, not a total, so it is
 * taken from whichever entry has the most games rather than summed. Identity
 * fields come from `primaryId` when present so the profile shows the team the
 * viewer arrived from.
 *
 * @param {object[]} rows player-stats entries (falsy entries ignored)
 * @param {string} primaryId the id that was actually requested
 */
export function mergeStatRows(rows, primaryId) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return { ...list[0] };

  const primary = list.find(r => r.__id === primaryId) || list[0];
  const ranked = list.slice().sort((a, b) => gamesOf(b) - gamesOf(a));

  const out = {
    ...primary,
    gamesPlayed:   sum(list, 'gamesPlayed'),
    gamesWon:      sum(list, 'gamesWon'),
    gamesLost:     sum(list, 'gamesLost'),
    matchesPlayed: sum(list, 'matchesPlayed'),
    ps:            sum(list, 'ps'),
    pa:            sum(list, 'pa'),
  };
  out.diff = (out.ps || 0) - (out.pa || 0);
  // Rating: the entry she actually played most under.
  out.composite = ranked.find(r => r.composite != null)?.composite ?? null;

  // byType: { womens: {won,lost,...}, ... }
  const byType = {};
  for (const r of list) {
    for (const [type, v] of Object.entries(r.byType || {})) {
      if (!byType[type]) byType[type] = {};
      for (const [k, n] of Object.entries(v || {})) {
        byType[type][k] = typeof n === 'number' ? (byType[type][k] || 0) + n : n;
      }
    }
  }
  if (Object.keys(byType).length) out.byType = byType;

  // partners: { partnerId: { played, won } }
  const partners = {};
  for (const r of list) {
    for (const [pid, v] of Object.entries(r.partners || {})) {
      if (!partners[pid]) partners[pid] = { played: 0, won: 0 };
      partners[pid].played += v?.played || 0;
      partners[pid].won    += v?.won || 0;
    }
  }
  if (Object.keys(partners).length) out.partners = partners;

  out.awards = list.flatMap(r => r.awards || []);
  // Every team she appeared for this season, so the profile can say so.
  out.teams = list
    .map(r => ({ teamId: r.teamId || null, teamName: r.teamName || null }))
    .filter((t, i, arr) => t.teamId && arr.findIndex(x => x.teamId === t.teamId) === i);
  return out;
}

function sum(rows, key) { return rows.reduce((a, r) => a + (r?.[key] || 0), 0); }
function gamesOf(r) { return (r?.gamesWon || 0) + (r?.gamesLost || 0); }
