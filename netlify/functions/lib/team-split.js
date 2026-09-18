// netlify/functions/lib/team-split.js
// Storage + data loading for the captain "Split with your team" feature.
// The maths lives in lib/team-split-math.js (pure, unit-tested).
//
// Store: `team-splits`, one record per team at `split/{teamId}.json`:
//   {
//     teamId, enabled, mode: 'flat' | 'pergame',
//     amountCents,                    // flat: amount being split
//     rateCents,                      // pergame: price per game played
//     buyInCents,                     // pergame: optional flat buy-in the per-game charges draw down
//     collect: 'weekly' | 'season',   // pergame: when the captain collects (display only)
//     venmoHandle,                    // the captain's handle — players pay the CAPTAIN
//     overrides: { [playerId]: cents },       // flat: pin one player's share
//     lockedAt, lockedBy, lockedPlayerIds,    // flat: player set frozen at roster lock
//     payments: { [playerId]: [{ id, cents, at, by, method, note }] },
//     claims:   { [playerId]: { cents, at } },   // player tapped "I paid"
//     nudges:   { [playerId]: 'YYYY-MM-DD' },    // one reminder per player per day
//     gamesCache: { [matchId]: { finalizedAt, week, phase, counts } },
//     announcedAt, createdAt, updatedAt, updatedBy
//   }
//
// No money moves through the app. This is a ledger of what players owe their
// captain; the captain still pays the league exactly as before.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './circuit.js';
import { countGames, buildLedger } from './team-split-math.js';

const splitStore = () => getStore({ name: 'team-splits', consistency: 'strong' });
const keyOf = (teamId) => `split/${teamId}.json`;

export async function getSplit(teamId) {
  if (!teamId) return null;
  return splitStore().get(keyOf(teamId), { type: 'json' }).catch(() => null);
}

export async function saveSplit(split, byEmail) {
  const now = new Date().toISOString();
  split.updatedAt = now;
  if (byEmail) split.updatedBy = byEmail;
  if (!split.createdAt) split.createdAt = now;
  await splitStore().setJSON(keyOf(split.teamId), split);
  return split;
}

export function newSplit(teamId) {
  return {
    teamId, enabled: false, mode: 'flat', amountCents: 0, rateCents: 0, collect: 'weekly',
    venmoHandle: null, overrides: {}, lockedAt: null, lockedBy: null, lockedPlayerIds: null,
    payments: {}, claims: {}, nudges: {}, gamesCache: {},
  };
}

export async function listSplits() {
  const store = splitStore();
  const { blobs } = await store.list({ prefix: 'split/' });
  const out = [];
  for (const b of blobs) {
    const s = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (s?.teamId) out.push(s);
  }
  return out;
}

/**
 * Same rule captain-roster.js enforces: the roster locks once the team's Week 2
 * match is finalized, unless an admin set the per-team unlock flag. Kept in step
 * with isRosterLocked() there — if that rule changes, change it here too.
 */
export async function isRosterLocked(team) {
  if (!team || team.rosterUnlocked === true) return false;
  try {
    const key = `schedule/${circuitCode(team.circuit)}/${team.division}/week-2.json`;
    const data = await getStore({ name: 'schedule', consistency: 'strong' }).get(key, { type: 'json' }).catch(() => null);
    const m = data?.matches?.find(x => x.teamA?.id === team.id || x.teamB?.id === team.id);
    return !!(m && m.finalizedAt);
  } catch { return false; }
}

/**
 * Per-game tabs: every FINALIZED match this team played, all season (regular
 * weeks, rivalry, playoffs, championship), with games played per player.
 *
 * useCache=true trusts split.gamesCache for matches whose finalizedAt hasn't
 * changed (the player page uses this — it loads on every visit). The captain
 * ledger recomputes from the lineup + score blobs every time and refreshes the
 * cache, so a corrected scoresheet self-heals the next time a captain looks.
 * @returns {{ tabs: Array, cacheChanged: boolean }}
 */
export async function loadTabs(team, split, { useCache = false } = {}) {
  const scheduleStore = getStore({ name: 'schedule', consistency: 'strong' });
  const lineupStore = getStore({ name: 'lineups', consistency: 'strong' });
  const scoresStore = getStore({ name: 'scores', consistency: 'strong' });
  const prefix = `schedule/${circuitCode(team.circuit)}/${team.division}/`;
  const { blobs } = await scheduleStore.list({ prefix }).catch(() => ({ blobs: [] }));

  const cache = split.gamesCache || {};
  const nextCache = {};
  const tabs = [];
  for (const b of blobs) {
    const wf = await scheduleStore.get(b.key, { type: 'json' }).catch(() => null);
    for (const m of (wf?.matches || [])) {
      if (!m?.finalizedAt || !m.id) continue;
      if (m.teamA?.id !== team.id && m.teamB?.id !== team.id) continue;
      const week = m.week ?? wf.week ?? null;
      const hit = cache[m.id];
      let counts;
      if (useCache && hit && hit.finalizedAt === m.finalizedAt) {
        counts = hit.counts || {};
      } else {
        const [lineup, score] = await Promise.all([
          lineupStore.get(`lineup/${m.id}/${team.id}.json`, { type: 'json' }).catch(() => null),
          scoresStore.get(`score/${m.id}.json`, { type: 'json' }).catch(() => null),
        ]);
        counts = countGames({ lineup, score, championship: !!m.championship });
      }
      nextCache[m.id] = { finalizedAt: m.finalizedAt, week, phase: m.phase || null, counts };
      tabs.push({ matchId: m.id, week, phase: m.phase || null, counts });
    }
  }
  const cacheChanged = JSON.stringify(cache) !== JSON.stringify(nextCache);
  split.gamesCache = nextCache;
  return { tabs, cacheChanged };
}

/**
 * Load everything and return the ledger. Also performs the two lazy writes:
 * freezing the flat player set once the roster locks, and refreshing the
 * per-game cache.
 */
export async function loadLedger(team, { useCache = false, split: given = null } = {}) {
  const split = given || await getSplit(team.id);
  if (!split) return { split: null, ledger: null, rosterLocked: false };
  let dirty = false;
  let rosterLocked = false;
  let tabs = [];

  if (split.mode === 'pergame') {
    const r = await loadTabs(team, split, { useCache });
    tabs = r.tabs;
    dirty = r.cacheChanged;
  } else {
    rosterLocked = await isRosterLocked(team);
    if (rosterLocked && !split.lockedAt && split.enabled) {
      split.lockedPlayerIds = (team.roster || []).filter(p => p && p.id && !p.archived && !p.pendingAdd).map(p => p.id);
      split.lockedAt = new Date().toISOString();
      split.lockedBy = 'roster-lock';
      dirty = true;
    }
  }
  if (dirty) await saveSplit(split).catch(e => console.warn('team-split lazy save skipped:', e?.message || e));
  return { split, ledger: buildLedger({ split, team, tabs }), rosterLocked };
}

/** Config fields safe to send to a captain / admin. */
export function publicConfig(split) {
  if (!split) return null;
  return {
    enabled: !!split.enabled, mode: split.mode, amountCents: split.amountCents || 0,
    rateCents: split.rateCents || 0, buyInCents: split.buyInCents || 0, collect: split.collect || 'weekly',
    venmoHandle: split.venmoHandle || null,
    lockedAt: split.lockedAt || null, lockedBy: split.lockedBy || null,
    announcedAt: split.announcedAt || null, updatedAt: split.updatedAt || null, updatedBy: split.updatedBy || null,
  };
}
