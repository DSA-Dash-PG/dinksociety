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
