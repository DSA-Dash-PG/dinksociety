// netlify/functions/lib/badges-config.js
// Source of truth + storage for the player badge system.
//
// Two things live in the 'badges' blob store (strong consistency):
//   • 'config'                      — admin overrides of the badge registry
//   • 'grants/<season>/<pid>.json'  — manually-granted awards per player
//
// The registry below is the built-in default. Admins can override label / tone /
// prestige / enabled / logo per badge from the admin Badges tab; we merge their
// overrides on top of these defaults so new code can add badges without wiping
// admin edits. Auto-derived badges (potw, ladder, streaks, undefeated) are
// computed on the profile surfaces from existing data; manual ones (champion,
// improved, bestdressed) are stored as grants here.

import { getStore } from '@netlify/blobs';

// tone ∈ gold | teal | lime | violet | rose  (matches public/badges.js)
export const DEFAULT_BADGES = [
  { kind: 'champion',    label: 'Season Champion',   tone: 'gold',   pri: 70, enabled: true, manual: true,  gendered: false, scopes: [] },
  { kind: 'potw',        label: 'Player of the Week', tone: 'gold',  pri: 60, enabled: true, manual: false, gendered: true,  scopes: ['weekly'] },
  { kind: 'ladder',      label: 'Ladder Winner',     tone: 'teal',   pri: 50, enabled: true, manual: false, gendered: false, scopes: [] },
  { kind: 'streak10',    label: '10+ Win Streak',    tone: 'lime',   pri: 45, enabled: true, manual: false, gendered: false, scopes: [] },
  { kind: 'improved',    label: 'Most Improved',     tone: 'violet', pri: 40, enabled: true, manual: true,  gendered: true,  scopes: ['weekly', 'season'] },
  { kind: 'undefeated',  label: 'Undefeated Night',  tone: 'lime',   pri: 30, enabled: true, manual: false, gendered: false, scopes: [] },
  { kind: 'bestdressed', label: 'Best Dressed',      tone: 'rose',   pri: 25, enabled: true, manual: true,  gendered: true,  scopes: ['weekly', 'season'] },
  { kind: 'streak5',     label: '5+ Win Streak',     tone: 'teal',   pri: 20, enabled: true, manual: false, gendered: false, scopes: [] },
];

const TONES = new Set(['gold', 'teal', 'lime', 'violet', 'rose', 'blue']);

function store() {
  return getStore({ name: 'badges', consistency: 'strong' });
}

// ── Config (registry overrides) ───────────────────────────────────
// Returns the resolved registry: defaults with any stored overrides applied,
// plus any admin-created custom badges, sorted by prestige (desc).
export async function getBadgeConfig() {
  let overrides = {};
  let custom = [];
  let meta = {};
  try {
    const raw = await store().get('config', { type: 'json' });
    if (raw && typeof raw === 'object') {
      overrides = raw.overrides || {};
      custom = Array.isArray(raw.custom) ? raw.custom : [];
      meta = { updatedAt: raw.updatedAt || null, updatedBy: raw.updatedBy || null };
    }
  } catch { /* first run — defaults only */ }

  const merged = DEFAULT_BADGES.map((b) => ({ ...b, ...(overrides[b.kind] || {}), kind: b.kind }));
  // Admin-created custom badges are always manual + non-derived.
  for (const c of custom) {
    if (!c || !c.kind || merged.some((m) => m.kind === c.kind)) continue;
    merged.push({
      kind: c.kind, label: c.label || c.kind, tone: TONES.has(c.tone) ? c.tone : 'gold',
      pri: Number(c.pri) || 10, enabled: c.enabled !== false, manual: true,
      gendered: !!c.gendered, scopes: Array.isArray(c.scopes) ? c.scopes : ['season'],
      logoId: c.logoId || null, custom: true,
    });
  }
  merged.sort((a, b) => (b.pri || 0) - (a.pri || 0));
  return { badges: merged, ...meta };
}

// Persist a partial override for one or more badges. `patch` shape:
//   { overrides: { potw: { label, tone, pri, enabled, logoId }, ... }, custom: [...] }
// Only known, safe fields are stored; everything merges over what's there.
export async function saveBadgeConfig(patch, adminEmail) {
  const s = store();
  let cur = {};
  try { cur = (await s.get('config', { type: 'json' })) || {}; } catch { cur = {}; }
  const overrides = { ...(cur.overrides || {}) };

  const ALLOW = ['label', 'tone', 'pri', 'enabled', 'logoId'];
  if (patch && patch.overrides && typeof patch.overrides === 'object') {
    for (const [kind, ov] of Object.entries(patch.overrides)) {
      const clean = {};
      for (const k of ALLOW) if (k in (ov || {})) clean[k] = ov[k];
      if ('tone' in clean && !TONES.has(clean.tone)) delete clean.tone;
      if ('pri' in clean) clean.pri = Number(clean.pri) || 0;
      if ('enabled' in clean) clean.enabled = !!clean.enabled;
      overrides[kind] = { ...(overrides[kind] || {}), ...clean };
    }
  }
  const custom = Array.isArray(patch?.custom) ? patch.custom : (cur.custom || []);
  const next = { overrides, custom, updatedAt: new Date().toISOString(), updatedBy: adminEmail || 'admin' };
  await s.set('config', JSON.stringify(next));
  return getBadgeConfig();
}

// Attach/replace a custom logo id on a badge (used after an image upload).
export async function setBadgeLogo(kind, logoId, adminEmail) {
  return saveBadgeConfig({ overrides: { [kind]: { logoId: logoId || null } } }, adminEmail);
}

// ── Grants (manual awards per player) ─────────────────────────────
function grantKey(season, playerId) {
  return `grants/${season}/${playerId}.json`;
}
function gid() {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return 'g_' + Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function listGrantsForPlayer(season, playerId) {
  try {
    const arr = await store().get(grantKey(season, playerId), { type: 'json' });
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// Grant `award` to many players at once (e.g. a whole championship roster).
// award: { kind, scope?, type?, week?, label?, date?, season }
export async function addGrant(season, playerIds, award, adminEmail) {
  const s = store();
  const ids = Array.isArray(playerIds) ? playerIds : [playerIds];
  const record = {
    id: gid(),
    kind: award.kind,
    scope: award.scope || null,
    type: award.type || null,
    week: award.week != null ? Number(award.week) : null,
    label: award.label || null,
    date: award.date || new Date().toISOString().slice(0, 10),
    season,
    grantedBy: adminEmail || 'admin',
    grantedAt: new Date().toISOString(),
  };
  let n = 0;
  for (const pid of ids) {
    if (!pid) continue;
    const key = grantKey(season, pid);
    let arr = [];
    try { arr = (await s.get(key, { type: 'json' })) || []; } catch { arr = []; }
    arr.push({ ...record, id: gid() }); // unique id per player
    await s.set(key, JSON.stringify(arr));
    n++;
  }
  return { ok: true, granted: n };
}

export async function removeGrant(season, playerId, grantId) {
  const s = store();
  const key = grantKey(season, playerId);
  let arr = [];
  try { arr = (await s.get(key, { type: 'json' })) || []; } catch { arr = []; }
  const next = arr.filter((g) => g.id !== grantId);
  await s.set(key, JSON.stringify(next));
  return { ok: true, removed: arr.length - next.length };
}

// Admin overview: every grant in a season, grouped by player.
export async function listAllGrants(season) {
  const s = store();
  const out = {};
  try {
    const { blobs } = await s.list({ prefix: `grants/${season}/` });
    for (const b of blobs) {
      const pid = b.key.slice(`grants/${season}/`.length).replace(/\.json$/, '');
      const arr = await s.get(b.key, { type: 'json' });
      if (Array.isArray(arr) && arr.length) out[pid] = arr;
    }
  } catch { /* none yet */ }
  return out;
}
