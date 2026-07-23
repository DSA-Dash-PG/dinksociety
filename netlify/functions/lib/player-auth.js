// netlify/functions/lib/player-auth.js
// Magic-link auth for PLAYERS. A player is a roster entry embedded in a team
// (team/<id>.json → roster[]). We resolve them by the email they were rostered
// with. Separate cookie/stores from captains so the two sessions don't collide.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';
import { isTestTeam } from './circuit.js';
import { getJSON } from './retry.js';
import { getLiteByEmail, getLiteById } from './ladder-players.js';

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
  const code = genLoginCode();
  const normEmail = (email || '').toLowerCase();
  const expiresAt = new Date(Date.now() + TOKEN_MINUTES * 60 * 1000).toISOString();
  const store = getStore('player-tokens');
  await store.setJSON(`token/${token}.json`, {
    token, email: normEmail, playerId, teamId, code,
    createdAt: new Date().toISOString(),
    expiresAt,
  });
  // Reverse index: a typed 6-digit code resolves back to this token. A magic
  // link opens the system browser, not an installed PWA (separate cookie jar),
  // so home-screen app users sign in by typing the code inside the app instead.
  await store.setJSON(codeIndexKey(normEmail, code), { token, expiresAt });
  return { token, code };
}

// 6-digit numeric login code (zero-padded), paired with the requesting email.
function genLoginCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

// Non-reversible per-email key so the emailed code never appears in a blob key.
function emailHash(normEmail) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < normEmail.length; i++) { h ^= normEmail.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
function codeIndexKey(normEmail, code) {
  return `code/${emailHash(normEmail)}-${code}.json`;
}

// Verify an emailed 6-digit code for a given email. Returns the same shape as
// consumePlayerToken ({ email, playerId, teamId }) or null. Single-use: the
// underlying token is consumed, so the code and the magic link die together.
export async function verifyPlayerCode(rawEmail, rawCode) {
  const normEmail = (rawEmail || '').toString().trim().toLowerCase();
  const code = (rawCode || '').toString().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail) || !/^\d{6}$/.test(code)) return null;
  const store = getStore('player-tokens');
  const idxKey = codeIndexKey(normEmail, code);
  const idx = await store.get(idxKey, { type: 'json' }).catch(() => null);
  if (!idx || !idx.token) return null;
  if (idx.expiresAt && new Date(idx.expiresAt).getTime() < Date.now()) return null;
  // Defense-in-depth vs. a code collision overwriting the index: confirm the
  // token record still matches this email + code before consuming it.
  const rec = await store.get(`token/${idx.token}.json`, { type: 'json' }).catch(() => null);
  if (!rec || rec.email !== normEmail || rec.code !== code) return null;
  const consumed = await consumePlayerToken(idx.token);
  await store.delete(idxKey).catch(() => {});
  return consumed;
}
export async function consumePlayerToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const store = getStore('player-tokens');
  const key = `token/${token}.json`;
  const record = await store.get(key, { type: 'json' }).catch(() => null);
  if (!record) return null;
  if (record.used) return null; // single-use: already consumed → caller redirects ?error=invalid
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  // Mark used BEFORE the caller creates a session/cookie. If this write
  // fails, refuse the sign-in rather than leave a replayable token.
  try {
    await store.setJSON(key, { ...record, used: true, usedAt: new Date().toISOString() });
  } catch {
    return null;
  }
  return { email: record.email, playerId: record.playerId, teamId: record.teamId };
}

// ===== Resolve a player by their roster email =====
// Returns { playerId, teamId, name, team } or null. First roster match wins.
export async function findPlayerByEmail(rawEmail) {
  const norm = normalizeEmail(rawEmail);
  if (!norm) return null;
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  // Parallelize the blob reads — each get is an independent network call, so a
  // serial for-loop was paying N round-trips. Preserve first-match order.
  const teams = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
  for (const team of teams) {
    if (!team?.roster) continue;
    const entry = team.roster.find(p =>
      (p.normalizedEmail && p.normalizedEmail === norm) ||
      ((p.email || '').toLowerCase() === norm)
    );
    if (entry) return { playerId: entry.id, teamId: team.id, name: entry.name, team };
  }
  // Not on any team roster — fall back to a "lite" ladder-only account. Teams
  // always win (checked first), which is what makes migration-to-team seamless.
  const lite = await getLiteByEmail(norm);
  if (lite) return { playerId: lite.playerId, teamId: null, name: lite.name, team: null, lite: true };
  return null;
}

// Return EVERY team this email is rostered on: [{ playerId, teamId, name, team }].
// Powers the player team switcher. Test-season teams are excluded by default.
export async function findAllPlayerTeamsByEmail(rawEmail, { includeTest = false } = {}) {
  const norm = normalizeEmail(rawEmail);
  if (!norm) return [];
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  const teams = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
  const out = [];
  for (const team of teams) {
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
  // getJSON retries transient store hiccups so a blip doesn't sign the player out
  const session = await getJSON(sessionStore, `session/${sessionId}.json`).catch(() => null);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await sessionStore.delete(`session/${sessionId}.json`).catch(() => null);
    return null;
  }

  // Teamless (lite) ladder-only account: resolve from the ladder-players store
  // instead of a team roster. Email on the record must still match the session.
  if (!session.teamId) {
    const lite = await getLiteById(session.playerId);
    if (!lite) return null;
    const lEmail = normalizeEmail(lite.email);
    if (lEmail && session.email && lEmail !== session.email) return null;
    return {
      session: { id: sessionId, email: session.email },
      playerId: lite.playerId, teamId: null, team: null,
      player: { id: lite.playerId, name: lite.name, email: lite.email, gender: lite.gender || null },
      lite: true,
    };
  }

  const team = await getJSON(getStore('teams'), `team/${session.teamId}.json`).catch(() => null);
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
