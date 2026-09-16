// netlify/functions/lib/waiver.js
//
// MULTI-WAIVER model. The league requires one or more separate waivers — e.g.
// "The Dink Society" league waiver AND the "Dink House" venue waiver — each
// signed and tracked independently. A player can be signed for one and missing
// another. Signatures are ONLINE (player typed their name) or PAPER (admin
// marked a physical hard copy), and the audit distinguishes the two.
//
// Config lives in the `config` store under `circuit-settings`:
//   waivers: [ { id, title, text, version, enabled } ]
//   (legacy single fields waiverEnabled/waiverTitle/waiverText/waiverVersion
//    are migrated into a waivers[] entry with id 'league' on read.)
//
// Signatures live in the `waivers` store, latest-per-(waiver, player):
//   signature/<waiverId>/<playerId>.json
//     { waiverId, playerId, email, name, signedName, season, version,
//       method:'online'|'paper', signedAt, markedBy?, userAgent?, ip? }
//   + immutable audit copy: log/<waiverId>/<playerId>/<signedAt>.json
//
// "Current" = latest signature matches BOTH the active season AND the waiver's
// current version. New season or edited text (→ version bump) forces re-sign.

import { getStore } from '@netlify/blobs';
import { circuitCode } from './circuit.js';
import { liveCircuit } from './current-season.js';
import { identityIndex } from './league-identity.js';

function configStore() { return getStore({ name: 'config', consistency: 'strong' }); }

/** All configured waivers (enabled + disabled), normalized. Migrates legacy. */
export async function getAllWaivers() {
  try {
    const raw = await configStore().get('circuit-settings');
    const s = raw ? JSON.parse(raw) : {};
    let list = Array.isArray(s.waivers) ? s.waivers : null;
    if (!list) {
      // Migrate the old single-waiver fields into one entry.
      list = [{
        id: 'league',
        title: s.waiverTitle || 'Liability Waiver & Release',
        text: s.waiverText || '',
        version: Number(s.waiverVersion) || 0,
        enabled: !!s.waiverEnabled,
      }];
    }
    return list.map(w => ({
      id: String(w.id || 'league'),
      title: w.title || 'Liability Waiver',
      text: w.text || '',
      version: Number(w.version) || 0,
      enabled: !!w.enabled,
    }));
  } catch (e) {
    console.error('getAllWaivers failed:', e);
    return [];
  }
}

/** Only enabled waivers that actually have text (i.e. that players must sign). */
export async function getActiveWaivers() {
  return (await getAllWaivers()).filter(w => w.enabled && w.text.trim());
}

export async function getWaiverById(id) {
  return (await getAllWaivers()).find(w => w.id === id) || null;
}

export async function getSignature(waiverId, playerId) {
  if (!waiverId || !playerId) return null;
  try {
    return await getStore('waivers').get(`signature/${waiverId}/${playerId}.json`, { type: 'json' }).catch(() => null);
  } catch { return null; }
}

/**
 * One person can hold several roster ids (one per season, see
 * lib/league-identity.js) and a signature is stored under whichever id she
 * was signed in as. Look across ALL her ids: return the signature that
 * satisfies `{ season, version }` if any does, otherwise the most recent one
 * (so callers can still show "signed for Season 1, v2").
 */
export async function getSignatureAcross(waiverId, ids, { season, version } = {}) {
  const list = (ids || []).filter(Boolean);
  if (!waiverId || !list.length) return null;
  const sigs = (await Promise.all(list.map(id => getSignature(waiverId, id)))).filter(Boolean);
  if (!sigs.length) return null;
  const hit = sigs.find(s => Number(s.version) === Number(version) && String(s.season) === String(season));
  if (hit) return hit;
  return sigs.sort((a, b) => String(b.signedAt || '').localeCompare(String(a.signedAt || '')))[0];
}

/**
 * Which season a player's signature is FOR. The session may have landed on a
 * past-season team (login used to take the first roster match in blob order),
 * so "the team I'm signed in as" is the wrong anchor: a Season 1 signature
 * would read as current while the Season 2 captain sees the player unsigned.
 * Rule: if the player is rostered on any team in the live season, sign for
 * the live season; otherwise sign for the session team's season.
 *
 * @param {{ team?: object|null, playerTeams?: object[] }} opts
 *   playerTeams — every team this email is on (findAllPlayerTeamsByEmail)
 */
export async function waiverSeasonFor({ team, playerTeams }) {
  const live = await liveCircuit();
  const onLive = (playerTeams || []).some(t => circuitCode((t.team || t).circuit) === live);
  if (onLive) return live;
  return team ? circuitCode(team.circuit) : live;
}

/**
 * Roster players on `team` who still need to sign each active waiver for
 * `season`, looking across every id each person holds. Used by the captain
 * portal (to-do + reminders) and the reminder endpoint, so both agree.
 * @returns {Promise<Array<{ id, title, version, missing: object[] }>>}
 */
export async function rosterWaiverGaps(team, season) {
  const roster = (team?.roster || []).filter(p => p.id && !p.archived && !p.pendingAdd);
  const active = await getActiveWaivers();
  if (!active.length || !roster.length) return [];
  const index = await identityIndex();
  const out = [];
  for (const w of active) {
    const sigs = await listSignatures(w.id);
    const missing = roster.filter(p => {
      const ids = index.idsFor(p.id);
      return !ids.some(id => {
        const s = sigs[id];
        return s && Number(s.version) === Number(w.version) && String(s.season) === String(season);
      });
    });
    if (missing.length) out.push({ id: w.id, title: w.title, version: w.version, missing });
  }
  return out;
}

/** Satisfied = signed the current version for the current season (any method). */
export function isWaiverSatisfied({ waiver, signature, season }) {
  if (!waiver?.enabled || !waiver.text?.trim()) return true;
  if (!signature) return false;
  return signature.version === waiver.version && String(signature.season) === String(season);
}

/**
 * Record a signature for one waiver. method: 'online' | 'paper'.
 * For paper, pass markedBy (admin email). Returns the record.
 */
export async function recordSignature({ waiverId, playerId, email, name, signedName, season, version, method = 'online', markedBy = null, userAgent = null, ip = null }) {
  const store = getStore('waivers');
  const signedAt = new Date().toISOString();
  const record = {
    waiverId, playerId,
    email: email || null, name: name || null,
    signedName: String(signedName || name || '').slice(0, 120),
    season: String(season), version: Number(version) || 0,
    method: method === 'paper' ? 'paper' : 'online',
    signedAt,
    markedBy: markedBy || null,
    userAgent: userAgent ? String(userAgent).slice(0, 300) : null, ip,
  };
  await store.setJSON(`signature/${waiverId}/${playerId}.json`, record);
  await store.setJSON(`log/${waiverId}/${playerId}/${signedAt}.json`, record).catch(() => {});
  return record;
}

/** Remove a signature (e.g. admin un-marks a paper signature). */
export async function removeSignature(waiverId, playerId) {
  if (!waiverId || !playerId) return;
  await getStore('waivers').delete(`signature/${waiverId}/${playerId}.json`).catch(() => {});
}

/** All latest signatures for ONE waiver, keyed by playerId. */
export async function listSignatures(waiverId) {
  if (!waiverId) return {};
  try {
    const store = getStore('waivers');
    const { blobs } = await store.list({ prefix: `signature/${waiverId}/` }).catch(() => ({ blobs: [] }));
    const out = {};
    await Promise.all(blobs.map(async b => {
      const rec = await store.get(b.key, { type: 'json' }).catch(() => null);
      if (rec?.playerId) out[rec.playerId] = rec;
    }));
    return out;
  } catch (e) {
    console.error('listSignatures failed:', e);
    return {};
  }
}
