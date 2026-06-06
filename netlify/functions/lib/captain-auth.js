// netlify/functions/lib/captain-auth.js
// Magic-link auth for captains. No Supabase dependency.

import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './identity.js';
import { isTestTeam } from './circuit.js';
import { getJSON } from './retry.js';

const COOKIE_NAME = 'ds_captain_session';
const SESSION_DAYS = 30;
const TOKEN_MINUTES = 15;

// ===== Cookie helpers =====
export function getCaptainToken(req) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function buildCaptainCookie(sessionId) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict',
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ].join('; ');
}

export function buildClearCaptainCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ===== Session lifecycle =====
export async function createSession(team, email) {
  const sessionId = randomId(20);
  const store = getStore('captain-sessions');
  await store.setJSON(`session/${sessionId}.json`, {
    id: sessionId,
    teamId: team.id,
    email: email.toLowerCase(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  });
  return sessionId;
}

export async function deleteSession(sessionId) {
  if (!sessionId) return;
  const store = getStore('captain-sessions');
  await store.delete(`session/${sessionId}.json`).catch(() => null);
}

// ===== Magic-link tokens =====
export async function createMagicToken(email, teamId) {
  const token = randomId(24);
  const store = getStore('captain-tokens');
  await store.setJSON(`token/${token}.json`, {
    token,
    email: email.toLowerCase(),
    teamId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TOKEN_MINUTES * 60 * 1000).toISOString(),
  });
  return token;
}

export async function consumeMagicToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const store = getStore('captain-tokens');
  const record = await store.get(`token/${token}.json`, { type: 'json' });
  if (!record) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  await store.delete(`token/${token}.json`).catch(() => null);
  return { email: record.email, teamId: record.teamId };
}

// ===== Auth guard =====
export async function requireCaptain(req) {
  const sessionId = getCaptainToken(req);
  if (!sessionId) return null;

  const sessionStore = getStore('captain-sessions');
  // Retries transient store hiccups so a blip doesn't bounce the captain to login
  const session = await getJSON(sessionStore, `session/${sessionId}.json`)
    .catch(() => null);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await sessionStore.delete(`session/${sessionId}.json`).catch(() => null);
    return null;
  }

  const team = await getTeamById(session.teamId);
  if (!team) return null;
  // A "team leader" is the captain (team.captainEmail) OR a roster member flagged
  // isCaptain / isCoCaptain. Co-captains reach the captain portal via the player
  // login + captain-bootstrap SSO bridge, so they must pass this guard too.
  const role = leaderRole(team, session.email);
  if (!role) return null;

  return {
    session: { id: sessionId, email: session.email },
    team,
    user: { email: session.email, role },
  };
}

// ===== Team leadership =====
// Returns 'captain' | 'cocaptain' | null for the given email on a team.
export function leaderRole(team, email) {
  const norm = normalizeEmail(email) || (email || '').toLowerCase();
  if (!team || !norm) return null;
  if ((team.captainEmail || '').toLowerCase() === norm) return 'captain';
  const entry = (team.roster || []).find(p =>
    (p.normalizedEmail && p.normalizedEmail === norm) ||
    ((p.email || '').toLowerCase() === norm)
  );
  if (entry) {
    if (entry.isCaptain) return 'captain';
    if (entry.isCoCaptain) return 'cocaptain';
  }
  return null;
}

// Scan all teams; return { team, role } for the team this email leads.
// Prefers a 'captain' match over a 'cocaptain' match if the email leads more
// than one team in different capacities.
export async function findTeamByLeaderEmail(email) {
  const norm = normalizeEmail(email) || (email || '').toLowerCase();
  if (!norm) return null;
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  let coMatch = null;
  for (const b of blobs) {
    const team = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!team) continue;
    const role = leaderRole(team, norm);
    if (role === 'captain') return { team, role };
    if (role === 'cocaptain' && !coMatch) coMatch = { team, role };
  }
  return coMatch;
}

// Scan all teams; return an array of { team, role } for EVERY team this email
// leads as captain or co-captain. Powers the captain team switcher. Test-season
// teams are excluded by default so they can't shadow a real team.
export async function findAllLeaderTeamsByEmail(email, { includeTest = false } = {}) {
  const norm = normalizeEmail(email) || (email || '').toLowerCase();
  if (!norm) return [];
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  const out = [];
  for (const b of blobs) {
    const team = await store.get(b.key, { type: 'json' }).catch(() => null);
    if (!team) continue;
    if (!includeTest && isTestTeam(team)) continue;
    const role = leaderRole(team, norm);
    if (role) out.push({ team, role });
  }
  // Stable, friendly ordering: captains first, then alphabetical by name.
  out.sort((a, b) =>
    (a.role === b.role ? 0 : a.role === 'captain' ? -1 : 1) ||
    (a.team.name || '').localeCompare(b.team.name || ''));
  return out;
}

// ===== Team lookups =====
export async function findTeamByCaptainEmail(email) {
  if (!email) return null;
  const normalized = email.toLowerCase();
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  for (const b of blobs) {
    const team = await store.get(b.key, { type: 'json' });
    if (team && (team.captainEmail || '').toLowerCase() === normalized) {
      return team;
    }
  }
  return null;
}

export async function getTeamById(teamId) {
  if (!teamId) return null;
  const store = getStore('teams');
  return await getJSON(store, `team/${teamId}.json`).catch(() => null);
}

// ===== Utilities =====
export function unauthResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}
