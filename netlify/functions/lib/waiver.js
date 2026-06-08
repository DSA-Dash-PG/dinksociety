// netlify/functions/lib/waiver.js
//
// Liability-waiver config + per-player signatures.
//
// Config lives in the `config` store under `circuit-settings` (admin-settings.js):
//   { waiverEnabled, waiverTitle, waiverText, waiverVersion }
//
// Signatures live in the `waivers` store, latest-per-player:
//   signature/<playerId>.json
//     { playerId, email, name, signedName, season, version, signedAt,
//       userAgent, ip }
// Plus an immutable audit copy per signing event:
//   log/<playerId>/<signedAt>.json   (same shape)
//
// A player is "current" when their latest signature matches BOTH the active
// season AND the active waiver version. So a new season forces a re-sign, and
// editing the waiver text (which bumps the version) also forces a re-sign.

import { getStore } from '@netlify/blobs';

export async function getWaiverConfig() {
  try {
    const store = getStore({ name: 'config', consistency: 'strong' });
    const raw = await store.get('circuit-settings');
    const s = raw ? JSON.parse(raw) : {};
    return {
      enabled: !!s.waiverEnabled,
      title: s.waiverTitle || 'Liability Waiver & Release',
      text: s.waiverText || '',
      version: Number(s.waiverVersion) || 0,
    };
  } catch (e) {
    console.error('getWaiverConfig failed:', e);
    return { enabled: false, title: '', text: '', version: 0 };
  }
}

export async function getSignature(playerId) {
  if (!playerId) return null;
  try {
    const store = getStore('waivers');
    return await store.get(`signature/${playerId}.json`, { type: 'json' }).catch(() => null);
  } catch {
    return null;
  }
}

/**
 * Has this player satisfied the CURRENT waiver for the CURRENT season?
 * If the waiver is disabled or has no text, it's vacuously satisfied.
 */
export function isWaiverSatisfied({ config, signature, season }) {
  if (!config?.enabled || !config.text?.trim()) return true;
  if (!signature) return false;
  return signature.version === config.version && String(signature.season) === String(season);
}

/**
 * Record a signature (latest + immutable audit copy). Returns the record.
 */
export async function recordSignature({ playerId, email, name, signedName, season, version, userAgent = null, ip = null }) {
  const store = getStore('waivers');
  const signedAt = new Date().toISOString();
  const record = {
    playerId, email: email || null, name: name || null,
    signedName: String(signedName || '').slice(0, 120),
    season: String(season), version: Number(version) || 0,
    signedAt, userAgent: userAgent ? String(userAgent).slice(0, 300) : null, ip,
  };
  await store.setJSON(`signature/${playerId}.json`, record);
  // Immutable audit copy — never overwritten (key includes the timestamp).
  await store.setJSON(`log/${playerId}/${signedAt}.json`, record).catch(() => {});
  return record;
}

/** All latest signatures, keyed by playerId. For the admin compliance view. */
export async function listSignatures() {
  try {
    const store = getStore('waivers');
    const { blobs } = await store.list({ prefix: 'signature/' }).catch(() => ({ blobs: [] }));
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
