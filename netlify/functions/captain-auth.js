// netlify/functions/lib/captain-auth.js
// Captain authentication library — magic-link sessions + multi-team support.
//
// Key change: findTeamsByCaptainEmail returns ALL teams for a captain,
// not just the first one. This supports captains who run teams in
// multiple divisions.

import { getStore } from '@netlify/blobs';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const COOKIE_NAME = 'ds_captain';

// ── Cookie helpers ──────────────────────────────────────────────

export function getCaptainToken(req) {
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function buildCaptainCookie(token, { maxAge = 60 * 60 * 24 * 30 } = {}) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function buildClearCaptainCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// ── Magic-link token management ─────────────────────────────────

export async function createMagicToken(email, teamId) {
  const store = getStore('captain-tokens');
  const token = crypto.randomBytes(32).toString('hex');
  const record = {
    token,
    email: email.toLowerCase(),
    teamId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min
  };
  await store.setJSON(`token/${token}`, record);
  return token;
}

export async function consumeMagicToken(token) {
  const store = getStore('captain-tokens');
  const record = await store.get(`token/${token}`, { type: 'json' });
  if (!record) return null;
  // Delete immediately (one-time use)
  await store.delete(`token/${token}`);
  // Check expiry
  if (new Date(record.expiresAt) < new Date()) return null;
  return record;
}

// ── Session management ──────────────────────────────────────────

export async function createSession(email) {
  const store = getStore('captain-sessions');
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session = {
    id: sessionId,
    email: email.toLowerCase(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
  };
  await store.setJSON(`session/${sessionId}`, session);
  return sessionId;
}

export async function getSession(sessionId) {
  const store = getStore('captain-sessions');
  const session = await store.get(`session/${sessionId}`, { type: 'json' });
  if (!session) return null;
  if (new Date(session.expiresAt) < new Date()) {
    await store.delete(`session/${sessionId}`);
    return null;
  }
  return session;
}

export async function deleteSession(sessionId) {
  const store = getStore('captain-sessions');
  await store.delete(`session/${sessionId}`);
}

// ── Team lookups ────────────────────────────────────────────────

/**
 * Returns ALL teams where the given email is captain.
 * Supports captains running teams in multiple divisions.
 */
export async function findTeamsByCaptainEmail(email) {
  const normalized = email.toLowerCase();
  const store = getStore('teams');
  const { blobs } = await store.list({ prefix: 'team/' });
  const teams = [];
  for (const b of blobs) {
    const team = await store.get(b.key, { type: 'json' });
    if (team && (team.captainEmail || '').toLowerCase() === normalized) {
      teams.push(team);
    }
  }
  return teams;
}

/**
 * Legacy single-team lookup — returns the first match.
 * Kept for backward compatibility but prefer findTeamsByCaptainEmail.
 */
export async function findTeamByCaptainEmail(email) {
  const teams = await findTeamsByCaptainEmail(email);
  return teams[0] || null;
}

/** Look up a single team by ID. */
export async function getTeamById(teamId) {
  const store = getStore('teams');
  // Try the prefixed key first (team/{id}.json), then bare
  let team = await store.get(`team/${teamId}.json`, { type: 'json' });
  if (!team) team = await store.get(`team/${teamId}`, { type: 'json' });
  if (!team) team = await store.get(teamId, { type: 'json' });
  return team;
}

// ── Auth middleware ──────────────────────────────────────────────

/**
 * Returns { email, teams } if the request has a valid captain session.
 * `teams` is an array of all teams this captain manages.
 * Returns null if unauthenticated.
 */
export async function requireCaptain(req) {
  const token = getCaptainToken(req);
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  const teams = await findTeamsByCaptainEmail(session.email);
  if (!teams.length) return null;

  return { user: { email: session.email }, teams };
}

/**
 * Like requireCaptain but also validates a specific team ID belongs
 * to this captain. Returns { email, team } for the specific team.
 */
export async function requireCaptainForTeam(req, teamId) {
  const ctx = await requireCaptain(req);
  if (!ctx) return null;

  const team = ctx.teams.find(t => t.id === teamId);
  if (!team) return null;

  return { user: ctx.user, team };
}

export function unauthResponse() {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}
