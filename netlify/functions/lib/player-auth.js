// netlify/functions/lib/player-auth.js
// Magic-link auth for PLAYERS. A player is a roster entry embedded in a team
// (team/<id>.json → roster[]). We resolve them by the email they were rostered
// with. Separate cookie/stores from captains so the two sessions don't collide.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';
import { isTestTeam } from './circuit.js';

const COOKIE_NAME = 'ds_player_session';
const SESSION_DAYS = 30;
const TOKEN_MINUTES = 15;

// ===== Cookies =====
export function getPlayerToken(req) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}
export function buildPlayerCookie(sessionId) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ].join('; ');
}
export function buildClearPlayerCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ===== Sessions =====
export async function createPlayerSession({ playerId, teamId, email }) {
  const sessionId = randomId(20);
  const store = getStore('player-sessions');
  await store.setJSON(`session/${sessionId}.json`, {
    id: sessionId, playerId, teamId, email: email.toLowerCase(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });
  return sessionId;
}
export async function deletePlayerSession(sessionId) {
  if (!sessionId) return;
  await getStore('player-sessions').delete(`session/${sessionId}.json`).catch(() => null);
}

// ===== Magic-link tokens =====
export async function createPlayerToken({ email, playerId, teamId }) {
  const token = randomId(24);
  await getStore('player-tokens').setJSON(`token/${token}.json`, {
    token, email: email.toLowerCase(), playerId, teamId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TOKEN_MINUTES * 60 * 1000).toISOString(),
  });
  return token;
}
export async function consumePlayerToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const store = getStore('player-tokens');
  const record = await store.get(`token/${token}.json`, { type: 'json' }).catch(() => null);
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  await store.delete(`token/${token}.json`).catch(() => null);
  return { email: record.email, playerId: record.playerId, teamId: record.teamId };
}

// ===== Resolve a player by their roster email =====
// Returns { playerId, teamId, name, team } or null. First roster match wins.
export async function findPlayerByEmail(rawEmail) {
  const norm = normalizeEmail(rawEmail);
  if (!norm) return null;
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  for (const b of blobs) {
    const team = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!team?.roster) continue;
    const entry = team.roster.find(p =>
      (p.normalizedEmail && p.normalizedEmail === norm) ||
      ((p.email || '').toLowerCase() === norm)
    );
    if (entry) return { playerId: entry.id, teamId: team.id, name: entry.name, team };
  }
  return null;
}

// Return EVERY team this email is rostered on: [{ playerId, teamId, name, team }].
// Powers the player team switcher. Test-season teams are excluded by default.
export async function findAllPlayerTeamsByEmail(rawEmail, { includeTest = false } = {}) {
  const norm = normalizeEmail(rawEmail);
  if (!norm) return [];
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  const out = [];
  for (const b of blobs) {
    const team = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!team?.roster) continue;
    if (!includeTest && isTestTeam(team)) continue;
    const entry = team.roster.find(p =>
      (p.normalizedEmail && p.normalizedEmail === norm) ||
      ((p.email || '').toLowerCase() === norm)
    );
    if (entry) out.push({ playerId: entry.id, teamId: team.id, name: entry.name, team });
  }
  out.sort((a, b) => (a.team.name || '').localeCompare(b.team.name || ''));
  return out;
}

// ===== Auth guard =====
export async function requirePlayer(req) {
  const sessionId = getPlayerToken(req);
  if (!sessionId) return null;
  const sessionStore = getStore('player-sessions');
  const session = await sessionStore.get(`session/${sessionId}.json`, { type: 'json' }).catch(() => null);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await sessionStore.delete(`session/${sessionId}.json`).catch(() => null);
    return null;
  }
  const team = await getStore('teams').get(`team/${session.teamId}.json`, { type: 'json' }).catch(() => null);
  if (!team?.roster) return null;
  // Confirm the player is still on this roster (by id, with matching email).
  const player = team.roster.find(p => p.id === session.playerId);
  if (!player) return null;
  const pEmail = (player.normalizedEmail || (player.email || '').toLowerCase());
  if (pEmail && pEmail !== session.email) return null;
  return { session: { id: sessionId, email: session.email }, playerId: session.playerId, teamId: session.teamId, team, player };
}

export function unauthResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  });
}

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
