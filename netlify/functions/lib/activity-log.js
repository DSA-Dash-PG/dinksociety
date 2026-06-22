// netlify/functions/lib/activity-log.js
//
// Site-wide activity log + usage tracking, surfaced in the admin
// "Activity" and "Analytics" tabs (admin-activity-log.js).
//
// Two kinds of blobs in the `activity-log` store:
//
//   event/<ISO-timestamp>_<rand>.json   — one immutable event per action
//     { id, at, type, actor: { email, role }, team: { id, name },
//       player: { id, name }, matchId, week, circuit, details }
//
//   seen/<email>.json                   — one mutable record per person
//     { email, name, role, teamId, teamName, firstLoginAt, lastLoginAt,
//       loginCount, lastSeenAt, lastVisitAt, visitCount,
//       tabs: { home: n, schedule: n, ... } }
//
//   pageview/<YYYY-MM-DD>.json           — one mutable record per day (ANON)
//     { date, hits, pages: { '/': n, ... }, visitors: [ vid, ... ] }
//     No PII — vid is a random per-browser id from localStorage.
//
// RULES:
//   - logActivity / recordLogin / recordSeen NEVER throw — an activity-log
//     hiccup must never break the action it's recording.
//   - Callers MUST await them (serverless execution freezes on response;
//     fire-and-forget writes silently never run — see rebuildStandings).
//   - Test-season activity (circuit TEST / circuit-test) is NOT logged.
//
// Event types in use:
//   admin.login, captain.login, player.login
//   player.added, player.removed, player.transferred
//   contact.updated, captain.set, cocaptain.set, cocaptain.removed
//   team.updated, roster.replaced
//   transfer.requested, transfer.denied
//   lineup.locked, lineup.unlocked, lineup.admin-edited
//   score.entry, score.confirmed, score.disputed, score.signoff, score.withdrawn, match.finalized
//   admin.visit, captain.visit, player.visit

import { getStore } from '@netlify/blobs';
import { circuitCode, isTestTeam } from './circuit.js';

const STORE = 'activity-log';

// A new "visit" is a portal load whose previous activity is older than this.
// Tab switches within a session keep lastSeenAt fresh, so they don't count.
const VISIT_GAP_MS = 30 * 60 * 1000; // 30 min
const ANON_VISITOR_CAP = 5000;       // max unique ids stored per day blob

function randomId(bytes = 5) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Is this action part of the isolated QA test season? Checks every signal
// the caller can cheaply provide.
export function isTestActivity({ circuit, team, seasonId, matchId } = {}) {
  if (team && isTestTeam(team)) return true;
  if (seasonId === 'circuit-test') return true;
  if (circuit && circuitCode(circuit) === 'TEST') return true;
  if (matchId && /^m_TEST_/.test(matchId)) return true;
  return false;
}

/**
 * Write one activity event. Never throws. Skips test-season activity.
 *
 * logActivity({
 *   type: 'player.added',
 *   actor: { email, role },          // role: 'admin' | 'captain' | 'cocaptain' | 'player' | 'system'
 *   team:  { id, name } | teamObj,   // full team blob is fine — trimmed + used for test detection
 *   player:{ id, name },
 *   matchId, week, circuit, seasonId,
 *   details: 'human-readable summary',
 * })
 */
export async function logActivity(evt = {}) {
  try {
    if (!evt.type) return null;
    const teamBlob = evt.team || null;
    if (isTestActivity({ circuit: evt.circuit || teamBlob?.circuit, team: teamBlob, seasonId: evt.seasonId || teamBlob?.seasonId, matchId: evt.matchId })) {
      return null;
    }
    const at = new Date().toISOString();
    const id = `${at}_${randomId()}`;
    const record = {
      id,
      at,
      type: evt.type,
      actor: evt.actor ? { email: evt.actor.email || null, role: evt.actor.role || null } : null,
      team: teamBlob ? { id: teamBlob.id || null, name: teamBlob.name || null } : null,
      player: evt.player ? { id: evt.player.id || null, name: evt.player.name || null } : null,
      matchId: evt.matchId || null,
      week: evt.week ?? null,
      circuit: evt.circuit ? circuitCode(evt.circuit) : (teamBlob?.circuit ? circuitCode(teamBlob.circuit) : null),
      details: evt.details || null,
    };
    await getStore(STORE).setJSON(`event/${id}.json`, record);
    return record;
  } catch (err) {
    console.error('logActivity failed (non-fatal):', err);
    return null;
  }
}

/**
 * Record a login: writes a *.login event AND updates the per-person
 * seen/ record that powers the Analytics tab. Never throws.
 */
export async function recordLogin({ email, role, name = null, team = null, playerId = null }) {
  try {
    if (!email) return;
    if (team && isTestTeam(team)) return;
    const norm = email.toLowerCase();
    const store = getStore(STORE);
    const key = `seen/${encodeURIComponent(norm)}.json`;
    const now = new Date().toISOString();
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    const rec = existing || { email: norm, firstLoginAt: now, loginCount: 0, tabs: {} };
    rec.role = role || rec.role || null;
    if (name) rec.name = name;
    if (playerId) rec.playerId = playerId;
    if (team) { rec.teamId = team.id || rec.teamId || null; rec.teamName = team.name || rec.teamName || null; }
    rec.lastLoginAt = now;
    rec.lastSeenAt = now;
    rec.loginCount = (rec.loginCount || 0) + 1;
    await store.setJSON(key, rec);

    await logActivity({
      type: `${role || 'player'}.login`,
      actor: { email: norm, role },
      team,
      player: playerId ? { id: playerId, name: name } : null,
      details: `${name || norm} signed in${team?.name ? ` (${team.name})` : ''}`,
    });
  } catch (err) {
    console.error('recordLogin failed (non-fatal):', err);
  }
}

/**
 * Lightweight "still using the site" ping — bumps lastSeenAt and optional
 * per-tab counters on the seen/ record. No event blob (would be noise).
 * Throttled: lastSeenAt only rewritten if stale by > 5 min, unless a tab
 * counter needs bumping. Never throws.
 */
export async function recordSeen({ email, tab = null, name = null, team = null }) {
  try {
    if (!email) return;
    if (team && isTestTeam(team)) return;
    const norm = email.toLowerCase();
    const store = getStore(STORE);
    const key = `seen/${encodeURIComponent(norm)}.json`;
    const now = Date.now();
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    const rec = existing || { email: norm, loginCount: 0, tabs: {} };
    const stale = !rec.lastSeenAt || (now - new Date(rec.lastSeenAt).getTime()) > 5 * 60 * 1000;
    if (!tab && !stale) return; // nothing worth a write
    if (name && !rec.name) rec.name = name;
    if (team) { rec.teamId = team.id || rec.teamId || null; rec.teamName = team.name || rec.teamName || null; }
    if (tab) {
      rec.tabs = rec.tabs || {};
      const t = String(tab).slice(0, 24).replace(/[^a-z0-9_-]/gi, '');
      if (t) rec.tabs[t] = (rec.tabs[t] || 0) + 1;
    }
    rec.lastSeenAt = new Date(now).toISOString();
    await store.setJSON(key, rec);
  } catch (err) {
    console.error('recordSeen failed (non-fatal):', err);
  }
}

/**
 * Record a portal *visit* — fired on page load (cookie OR magic-link auth).
 * Uses a session-gap heuristic so it counts genuine return trips rather than
 * every tab click: a visit is only counted when the last activity is older
 * than VISIT_GAP_MS. On a new visit it bumps visitCount on the seen/ record
 * AND writes a `<role>.visit` event for the Activity timeline. Always refreshes
 * lastSeenAt + the landing-tab counter. Never throws; test teams skipped.
 */
export async function recordVisit({ email, role = 'player', tab = null, name = null, team = null }) {
  try {
    if (!email) return;
    if (team && isTestTeam(team)) return;
    const norm = email.toLowerCase();
    const store = getStore(STORE);
    const key = `seen/${encodeURIComponent(norm)}.json`;
    const now = Date.now();
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    const rec = existing || { email: norm, loginCount: 0, tabs: {} };
    const last = rec.lastSeenAt ? new Date(rec.lastSeenAt).getTime() : 0;
    const isNewVisit = !last || (now - last) > VISIT_GAP_MS;

    if (role) rec.role = role || rec.role || null;
    if (name && !rec.name) rec.name = name;
    if (team) { rec.teamId = team.id || rec.teamId || null; rec.teamName = team.name || rec.teamName || null; }
    if (tab) {
      rec.tabs = rec.tabs || {};
      const t = String(tab).slice(0, 24).replace(/[^a-z0-9_-]/gi, '');
      if (t) rec.tabs[t] = (rec.tabs[t] || 0) + 1;
    }
    if (isNewVisit) {
      rec.visitCount = (rec.visitCount || 0) + 1;
      rec.lastVisitAt = new Date(now).toISOString();
    }
    rec.lastSeenAt = new Date(now).toISOString();
    await store.setJSON(key, rec);

    if (isNewVisit) {
      await logActivity({
        type: `${role || 'player'}.visit`,
        actor: { email: norm, role },
        team,
        player: rec.playerId ? { id: rec.playerId, name: rec.name } : null,
        details: `${rec.name || norm} opened the ${role || 'player'} portal${team?.name ? ` (${team.name})` : ''}`,
      });
    }
  } catch (err) {
    console.error('recordVisit failed (non-fatal):', err);
  }
}

/**
 * Record an ANONYMOUS public-page view. No session, no PII — `vid` is a random
 * per-browser id (localStorage) used only to estimate daily uniques. Rolls up
 * into one mutable blob per day. Never throws.
 */
export async function recordPageview({ path, vid = null }) {
  try {
    const store = getStore(STORE);
    const day = new Date().toISOString().slice(0, 10);
    const key = `pageview/${day}.json`;
    const rec = (await store.get(key, { type: 'json' }).catch(() => null))
      || { date: day, hits: 0, pages: {}, visitors: [] };
    rec.hits = (rec.hits || 0) + 1;
    const p = normalizePath(path);
    rec.pages = rec.pages || {};
    rec.pages[p] = (rec.pages[p] || 0) + 1;
    rec.visitors = rec.visitors || [];
    if (vid && rec.visitors.length < ANON_VISITOR_CAP && !rec.visitors.includes(vid)) {
      rec.visitors.push(vid);
    }
    await store.setJSON(key, rec);
  } catch (err) {
    console.error('recordPageview failed (non-fatal):', err);
  }
}

function normalizePath(path) {
  let p = String(path || '/').split('?')[0].split('#')[0].toLowerCase().slice(0, 80);
  if (!p.startsWith('/')) p = '/' + p;
  return p || '/';
}
