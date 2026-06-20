// netlify/functions/lib/xp-config.js
//
// Admin-configurable XP: (1) the AMOUNTS for the built-in automatic rules
// (played, game win, place, MVP, most wins, best diff, comeback), and (2) custom
// AWARD types the organizer defines (e.g. "Volunteer +10") and GRANTS to players.
// Grants are a per-player ledger added on top of the computed XP.
//
//   ladder-xp  config.json  → { amounts:{...}, awards:[{id,label,xp}] }
//   ladder-xp  grants.json  → [{ id, playerId, label, xp, awardId?, at }]

import { getStore } from '@netlify/blobs';
import { XP_DEFAULTS } from './ladder-scoring.js';

const STORE = 'ladder-xp';
function store() { return getStore({ name: STORE, consistency: 'strong' }); }
const rid = () => 'x_' + Math.random().toString(36).slice(2, 10);

// { amounts (built-in rule values, merged with defaults), awards (custom types) }
export async function getXpConfig() {
  const c = await store().get('config.json', { type: 'json' }).catch(() => null);
  return { amounts: { ...XP_DEFAULTS, ...(c?.amounts || {}) }, awards: Array.isArray(c?.awards) ? c.awards : [] };
}

export async function setXpConfig({ amounts, awards }) {
  const cur = await getXpConfig();
  const next = {
    amounts: { ...cur.amounts, ...(amounts || {}) },
    awards: Array.isArray(awards) ? awards : cur.awards,
    updatedAt: new Date().toISOString(),
  };
  await store().setJSON('config.json', next);
  return next;
}

// Add or update a custom award type. Returns the awards array.
export async function upsertAward({ id, label, xp }) {
  const cur = await getXpConfig();
  const awards = cur.awards.slice();
  const clean = { id: id || rid(), label: String(label || '').trim().slice(0, 60), xp: Math.round(Number(xp) || 0) };
  if (!clean.label) throw new Error('label required');
  const i = awards.findIndex(a => a.id === clean.id);
  if (i >= 0) awards[i] = clean; else awards.push(clean);
  await setXpConfig({ awards });
  return awards;
}

export async function removeAward(id) {
  const cur = await getXpConfig();
  await setXpConfig({ awards: cur.awards.filter(a => a.id !== id) });
  return true;
}

// ── Manual grants (ledger) ──
export async function getXpGrants() {
  const g = await store().get('grants.json', { type: 'json' }).catch(() => null);
  return Array.isArray(g) ? g : [];
}

export async function addXpGrant({ playerId, label, xp, awardId }) {
  if (!playerId) throw new Error('playerId required');
  const grants = await getXpGrants();
  const entry = { id: rid(), playerId, label: String(label || 'Bonus').slice(0, 60), xp: Math.round(Number(xp) || 0), awardId: awardId || null, at: new Date().toISOString() };
  grants.push(entry);
  await store().setJSON('grants.json', grants);
  return entry;
}

export async function removeXpGrant(id) {
  const grants = await getXpGrants();
  await store().setJSON('grants.json', grants.filter(g => g.id !== id));
  return true;
}

// Sum of granted XP per player → { playerId: totalXp }.
export function grantTotals(grants) {
  const m = {};
  (grants || []).forEach(g => { m[g.playerId] = (m[g.playerId] || 0) + (Number(g.xp) || 0); });
  return m;
}
