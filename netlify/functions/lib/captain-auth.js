// netlify/functions/lib/captain-auth.js
// Magic-link auth for captains. No Supabase dependency.

import { getStore } from '@netlify/blobs';

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
  const session = await sessionStore.get(`session/${sessionId}.json`, { type: 'json' })
    .catch(() => null);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await sessionStore.delete(`session/${sessionId}.json`).catch(() => null);
    return null;
  }

  const team = await getTeamById(session.teamId);
  if (!team) return null;
  if ((team.captainEmail || '').toLowerCase() !== session.email) return null;

  return {
    session: { id: sessionId, email: session.email },
    team,
    user: { email: session.email },
  };
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
  return await store.get(`team/${teamId}.json`, { type: 'json' }).catch(() => null);
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
